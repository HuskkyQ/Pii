/**
 * 自定义会话标题。
 *
 * pi-durable 的 conversation 只有 id / parent / owner，**没有标题字段**，
 * 默认标题是「从第一条用户消息推出来」的（见 conversations.ts）。
 *
 * 用户手动改名后，把「id → 标题」记在这个小文件里，覆盖自动标题：
 *  - 不碰库表、不动 Harness，删掉这个文件就退回全自动
 *  - 值为空 = 恢复自动：写入时顺手把 key 删掉，而不是存空串
 *
 * 和 hidden-conversations.json 是同一套思路：纯文件、秒生效、失败不影响主流程。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TITLES_FILE = "conversation-titles.json";

/** 标题长度上限（服务端校验，前端 maxLength 同步用）。 */
export const TITLE_MAX = 100;

function readTitles(dataDir: string): Record<string, string> {
  const path = join(dataDir, TITLES_FILE);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim()) result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

function writeTitles(dataDir: string, titles: Record<string, string>): void {
  // 按 id 数值排序，方便人肉看文件
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(titles).sort((a, b) => Number(a) - Number(b))) {
    sorted[key] = titles[key];
  }
  writeFileSync(join(dataDir, TITLES_FILE), JSON.stringify(sorted, null, 2));
}

/** 自定义标题表。启动时读一次，之后一直在内存里。 */
export class Titles {
  #dataDir: string;
  #titles: Record<string, string>;

  constructor(dataDir: string) {
    this.#dataDir = dataDir;
    this.#titles = readTitles(dataDir);
  }

  get(id: number): string | undefined {
    return this.#titles[String(id)];
  }

  /** 设标题；传空串（或全空白）表示恢复自动标题。 */
  set(id: number, title: string): void {
    const flat = title.replace(/\s+/g, " ").trim();
    if (flat) this.#titles[String(id)] = flat;
    else delete this.#titles[String(id)];
    writeTitles(this.#dataDir, this.#titles);
  }

  /** 会话被真删掉了，顺手把它的自定义标题也划掉。 */
  forget(id: number): void {
    if (!(String(id) in this.#titles)) return;
    delete this.#titles[String(id)];
    writeTitles(this.#dataDir, this.#titles);
  }
}
