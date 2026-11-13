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
import { normalizePolicy } from "../src/server/policies.ts";
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
