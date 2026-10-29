/**
 * 删除会话。
 *
 * 为什么不用「直接 DELETE FROM conversations」一条搞定：
 * 一个会话在库里散落在 6 张表（entries / documents / document_revisions /
 * submissions / tasks / conversations），漏一张就会留下孤儿行；
 * 更要紧的是 **Harness 在内存里缓存着这个会话的文档和上下文**，
 * 正在被打开的时候删表，下一次自动续跑会往一个不存在的会话里写东西。
 *
 * 所以分两步，各管一件事：
 *   1. 立刻「藏起来」 → 界面上消失、API 返回 404（hidden.json，纯文件，秒生效）
 *   2. 真正删行 → 只在**没有人在看、也没有在跑**的时候立刻做；
 *      做不了就等下次启动，那时库还没被打开，删得最干净
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HIDDEN_FILE = "hidden-conversations.json";

function readHidden(dataDir: string): number[] {
  const path = join(dataDir, HIDDEN_FILE);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is number => typeof id === "number") : [];
  } catch {
    return [];
  }
}

function writeHidden(dataDir: string, ids: number[]): void {
  writeFileSync(join(dataDir, HIDDEN_FILE), JSON.stringify([...new Set(ids)].sort((a, b) => a - b), null, 2));
}

/** 被删掉的会话 id。启动时读一次，之后一直在内存里。 */
export class Trash {
  #dataDir: string;
  #hidden: Set<number>;

  constructor(dataDir: string) {
    this.#dataDir = dataDir;
    this.#hidden = new Set(readHidden(dataDir));
  }

  has(id: number): boolean {
    return this.#hidden.has(id);
  }

  list(): number[] {
    return [...this.#hidden];
  }

  hide(id: number): void {
    this.#hidden.add(id);
    writeHidden(this.#dataDir, [...this.#hidden]);
  }

  /** 行已经被真删掉了，从名单里划掉（下次就不用再删一遍）。 */
  forget(ids: number[]): void {
    for (const id of ids) this.#hidden.delete(id);
    writeHidden(this.#dataDir, [...this.#hidden]);
  }
}

interface PurgeOptions {
  dbPath: string;
  ids: number[];
}

/**
 * 真删行。用一条独立连接、一个事务，失败就整体回滚（名单留着，下次启动再试）。
 *
 * 顺序有讲究：先删子表（revisions → documents / entries / submissions / tasks），
 * 最后删 conversations，这样任何一步失败都不会留下指向已删父行的引用。
 */
export function purgeConversations({ dbPath, ids }: PurgeOptions): { deleted: number[]; failed?: string } {
  if (ids.length === 0) return { deleted: [] };
  if (!existsSync(dbPath)) return { deleted: [] };

  const db = new DatabaseSync(dbPath);
  const deleted: number[] = [];

  try {
    db.exec("PRAGMA busy_timeout = 3000");
    db.exec("BEGIN IMMEDIATE");
    for (const id of ids) {
      db.prepare(
        "DELETE FROM document_revisions WHERE document_id IN (SELECT id FROM documents WHERE scope_kind = 'conversation' AND owner_id = ?)",
      ).run(id);
      db.prepare("DELETE FROM documents WHERE scope_kind = 'conversation' AND owner_id = ?").run(id);
      db.prepare("DELETE FROM entries WHERE conversation_id = ?").run(id);
      db.prepare("DELETE FROM submissions WHERE conversation_id = ?").run(id);
      db.prepare("DELETE FROM tasks WHERE conversation_id = ?").run(id);
      db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
      deleted.push(id);
    }
    db.exec("COMMIT");
    return { deleted };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 回滚失败也就算了，事务本来就断了 */
    }
    return { deleted: [], failed: error instanceof Error ? error.message : String(error) };
  } finally {
    db.close();
  }
}
