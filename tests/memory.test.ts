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
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pii-memory-test-"));
  const dbPath = join(dir, "agent.sqlite");
  const store = new MemoryStore({
    dbPath,
    ...(budgetChars === undefined ? {} : { budgetChars }),
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
