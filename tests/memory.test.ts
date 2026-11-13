/**
 * 全局记忆的读路径测试。
 *
 * P0 没有写入 API，所以这里用一条独立连接直接 INSERT —— 顺带证明表结构
 * 对「手工改库」这条路是通的（线上临时加一条记忆就靠它）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry } from "@earendil-works/pi-durable";

import { memoryExtension } from "../src/memory/section.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { memoryTool } from "../src/tools/memory.ts";

interface Row {
  content: string;
  tags?: string;
  pinned?: boolean;
  updatedAt?: number;
}

function seed(dbPath: string, rows: Row[]): void {
  const db = new DatabaseSync(dbPath);
  try {
    const insert = db.prepare(
      `INSERT INTO pii_memory (content, normalized, tags, pinned, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'manual', ?, ?)`,
    );
    for (const row of rows) {
      const at = row.updatedAt ?? 1_000;
      insert.run(
        row.content,
        `${row.content.trim().toLowerCase()}-${at}`,
        row.tags ?? "",
        row.pinned ? 1 : 0,
        at,
        at,
      );
    }
  } finally {
    db.close();
  }
}

async function withStore(
  budgetChars: number | undefined,
  body: (store: MemoryStore, dbPath: string) => void | Promise<void>,
  maxEntries?: number,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pii-memory-test-"));
  const dbPath = join(dir, "agent.sqlite");
  const store = new MemoryStore({
    dbPath,
    ...(budgetChars === undefined ? {} : { budgetChars }),
    ...(maxEntries === undefined ? {} : { maxEntries }),
  });
  try {
    await body(store, dbPath);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("空表：不渲染任何 section，injected 为 0", async () => {
  await withStore(undefined, (store) => {
    assert.equal(store.renderForPrompt(), undefined);
    assert.deepEqual(store.snapshot(), { entries: [], injected: 0, budgetChars: 1200 });
  });
});

test("排序：置顶在前，其余按更新时间倒序", async () => {
  await withStore(undefined, (store, dbPath) => {
    seed(dbPath, [
      { content: "旧的", updatedAt: 1_000 },
      { content: "新的", updatedAt: 3_000 },
      { content: "置顶的", pinned: true, updatedAt: 2_000 },
    ]);
    assert.deepEqual(
      store.list().map((entry) => entry.content),
      ["置顶的", "新的", "旧的"],
    );
  });
});

test("渲染格式：带 id、置顶标记、标签；换行压成空格", async () => {
  await withStore(undefined, (store, dbPath) => {
    seed(dbPath, [{ content: "第一行\n第二行", tags: "偏好, 部署", pinned: true }]);
    const text = store.renderForPrompt();
    assert.ok(text);
    assert.match(text, /^以下是与本机用户相关的长期记忆/);
    assert.match(text, /\[#1\]\[置顶\]\[偏好\]\[部署\] 第一行 第二行$/);
    assert.equal(store.snapshot().entries[0]!.tags.join("|"), "偏好|部署");
  });
});

test("预算：超了只注入前面的条目，且至少保留一条", async () => {
  await withStore(300, (store, dbPath) => {
    const long = "甲".repeat(120);
    seed(dbPath, [
      { content: `置顶 ${long}`, pinned: true, updatedAt: 1_000 },
      { content: `第二条 ${long}`, updatedAt: 2_000 },
    ]);
    const text = store.renderForPrompt();
    assert.ok(text);
    assert.match(text, /置顶/);
    assert.doesNotMatch(text, /第二条/);
    assert.equal(store.snapshot().injected, 1);
  });
});

test("预算：第一条就超预算时仍然注入（宁可挤一点，也不让模型以为没有记忆）", async () => {
  await withStore(50, (store, dbPath) => {
    seed(dbPath, [{ content: "乙".repeat(200) }]);
    const text = store.renderForPrompt();
    assert.ok(text);
    assert.match(text, /乙{200}/);
    assert.equal(store.snapshot().injected, 1);
  });
});

test("写入：add → update → remove 的完整生命周期", async () => {
  await withStore(undefined, (store) => {
    const added = store.add({ content: "用户用 pnpm", tags: ["偏好"], pinned: true });
    assert.ok(added.ok);
    assert.equal(added.created, true);
    assert.equal(added.entry.content, "用户用 pnpm");
    assert.deepEqual(added.entry.tags, ["偏好"]);
    assert.equal(added.entry.pinned, true);
    assert.equal(added.entry.source, "manual");

    const updated = store.update(added.entry.id, { content: "用户用 pnpm，不要 npm", pinned: false });
    assert.ok(updated.ok);
    assert.equal(updated.entry.content, "用户用 pnpm，不要 npm");
    assert.equal(updated.entry.pinned, false);
    assert.deepEqual(updated.entry.tags, ["偏好"]);

    assert.equal(store.remove(added.entry.id), true);
    assert.deepEqual(store.list(), []);
    assert.equal(store.remove(added.entry.id), false);
  });
});

test("写入：重复 add 幂等，返回同一条并更新时间", async () => {
  await withStore(undefined, (store) => {
    const first = store.add({ content: "用户用 pnpm" });
    const second = store.add({ content: "  用户用   pnpm  " });
    assert.ok(first.ok && second.ok);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.entry.id, first.entry.id);
    assert.ok(second.entry.updatedAt >= first.entry.updatedAt);
    assert.equal(store.list().length, 1);
  });
});

test("写入：空内容、超长、已满都会被拒", async () => {
  await withStore(
    undefined,
    (store) => {
      assert.deepEqual(store.add({ content: "   " }), { ok: false, reason: "empty" });
      assert.deepEqual(store.add({ content: "甲".repeat(1001) }), { ok: false, reason: "too-long" });
      assert.ok(store.add({ content: "第一条" }).ok);
      assert.deepEqual(store.add({ content: "第二条" }), { ok: false, reason: "full" });
    },
    1,
  );
});

test("写入：update 的不存在 / 撞车 / 空内容", async () => {
  await withStore(undefined, (store) => {
    const first = store.add({ content: "甲" });
    assert.ok(first.ok);
    const second = store.add({ content: "乙" });
    assert.ok(second.ok);

    assert.deepEqual(store.update(999, { content: "丙" }), { ok: false, reason: "not-found" });
    assert.deepEqual(store.update(first.entry.id, { content: "  " }), { ok: false, reason: "empty" });
    assert.deepEqual(store.update(first.entry.id, { content: "乙" }), {
      ok: false,
      reason: "duplicate",
    });
    // 改成自己原来的内容不算撞车
    assert.ok(store.update(second.entry.id, { content: "乙" }).ok);
  });
});

test("工具提示只在装了工具时出现", async () => {
  await withStore(undefined, (store) => {
    store.add({ content: "用户用 pnpm" });
    assert.doesNotMatch(String(store.renderForPrompt()), /memory 工具/);
    assert.match(String(store.renderForPrompt({ mentionTool: true })), /memory 工具/);
  });
});

test("工具：add 记为 agent 来源并带上会话 id，list 能列出来", async () => {
  await withStore(undefined, async (store) => {
    const tool = memoryTool(store);
    const api = { conversationId: 7 } as never;
    const added = await tool.execute({ action: "add", content: "用户用 pnpm" } as never, api, {} as never);
    assert.match(String((added.output as { text: string }[])[0]!.text), /已记住 #1/);

    const [entry] = store.list();
    assert.equal(entry!.source, "agent");
    assert.equal(entry!.conversationId, 7);

    const listed = await tool.execute({ action: "list" } as never, api, {} as never);
    assert.match(String((listed.output as { text: string }[])[0]!.text), /\[#1\].*用户用 pnpm/);

    const removed = await tool.execute({ action: "remove", id: entry!.id } as never, api, {} as never);
    assert.match(String((removed.output as { text: string }[])[0]!.text), /已删除/);
    assert.deepEqual(store.list(), []);
  });
});

test("扩展：tool 开关决定是否注册 memory 工具", async () => {
  await withStore(undefined, (store) => {
    const withTool = createRegistry();
    withTool.install(memoryExtension(store, { tool: true }));
    assert.ok(withTool.snapshot().tools().some(({ tool }) => tool.name === "memory"));

    const withoutTool = createRegistry();
    withoutTool.install(memoryExtension(store));
    assert.equal(
      withoutTool.snapshot().tools().some(({ tool }) => tool.name === "memory"),
      false,
    );
  });
});

test("扩展：装上后注册了 key=memory 的 section，并能渲染出记忆", async () => {
  await withStore(undefined, async (store, dbPath) => {
    seed(dbPath, [{ content: "用户用 pnpm，不要用 npm" }]);
    const registry = createRegistry();
    registry.install(memoryExtension(store));

    const found = registry.snapshot().sections().find(({ section }) => section.key === "memory");
    assert.ok(found);
    const text = await found.section.render({} as never, BACKGROUND_CONTEXT);
    assert.match(String(text), /用户用 pnpm/);
  });
});
