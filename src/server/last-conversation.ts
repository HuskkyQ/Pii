/**
 * "上次在看的会话"（服务端兜底）。
 *
 * 为什么需要它：前端已经把当前会话存进 localStorage，正常浏览器冷启动能恢复。
 * 但 **iOS 独立 PWA 上 localStorage 并不可靠**（可能被清、被隔离），
 * 只靠它会出现「关掉再开回到 root」。所以服务端再记一份：
 *
 *   - 客户端每次切到某个会话 → POST /api/last-conversation
 *   - 冷启动时 URL 没有 `?c=` 且 localStorage 也没有 → GET 它来恢复
 *
 * 单用户自托管，全局就一份，落 `last-conversation.json`。
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FILE = "last-conversation.json";

function read(dataDir: string): number | null {
  const path = join(dataDir, FILE);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const id =
      typeof parsed === "number"
        ? parsed
        : parsed && typeof parsed === "object"
          ? (parsed as { conversationId?: unknown }).conversationId
          : undefined;
    return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

export class LastConversation {
  #dataDir: string;
  #id: number | null;

  constructor(dataDir: string) {
    this.#dataDir = dataDir;
    this.#id = read(dataDir);
  }

  get(): number | null {
    return this.#id;
  }

  set(id: number | null): void {
    if (id === null) {
      this.#id = null;
      rmSync(join(this.#dataDir, FILE), { force: true });
      return;
    }
    this.#id = id;
    writeFileSync(join(this.#dataDir, FILE), JSON.stringify({ conversationId: id }, null, 2));
  }

  /** 会话被删掉了，如果正好是它，清掉，免得冷启动恢复到已删除会话。 */
  forget(id: number): void {
    if (this.#id === id) this.set(null);
  }
}
