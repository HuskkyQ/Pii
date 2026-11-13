/**
 * Web Push：服务端推一条系统通知到手机 / 桌面。
 *
 * 三块拼图：
 *  1. **VAPID 密钥对**（本机生成一次，落在数据目录）—— 它向推送服务证明「我是这个应用」。
 *  2. **订阅表**（浏览器给的 endpoint + 两个密钥）—— endpoint 就是推送服务的门牌号，
 *     `p256dh` / `auth` 用来加密 payload：推送服务只负责送，看不懂内容。
 *  3. **发送**（`webpush.sendNotification`）—— 404/410 说明订阅已失效，立刻删掉。
 *
 * 两个容易踩的坑：
 *  - 订阅和浏览器/设备绑定。换个浏览器、清过数据，旧 endpoint 就是死信箱（410）。
 *  - iOS 只在**添加到主屏幕之后**才给推送权限，而且必须 https。
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import webpush from "web-push";

import { loadConfig } from "../config.ts";
import { writeJsonAtomic } from "../atomic-file.ts";

/* 推送的形状与「出口类型」在 ports.ts（agent 层），实现留在本文件。 */
import type { PushPayload, PushPort } from "../ports.ts";
export type { PushPayload };

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** 订阅时正在看哪个会话；推送里带回去，点通知能跳对地方。 */
  conversationId?: number;
  addedAt: number;
}

export interface PushResult {
  sent: number;
  pruned: number;
  failed: number;
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface PushHubOptions {
  dataDir: string;
  /** 有人正开着这个会话时跳过推送 —— 你已经在看了，不用再响一次。 */
  isWatched?: (conversationId: number | undefined) => boolean;
}

const VAPID_FILE = "vapid.json";
const SUBS_FILE = "push-subscriptions.json";

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * 读出「文件在不在」这件事本身。
 *
 * 只靠 `readJson` 分不清两种 `undefined`：
 *   - 文件不存在   → 全新安装，生成一对新密钥没问题
 *   - 文件存在但坏了 → **绝不能覆盖重建**：VAPID 公钥换了，
 *     所有设备上已经注册的订阅立刻作废，用户得挨个重新「允许通知」
 * 所以这里单列一个状态，让调用方能区分对待。
 */
type FileState<T> = { kind: "missing" } | { kind: "corrupt" } | { kind: "ok"; value: T };

function readJsonWithState<T>(path: string): FileState<T> {
  if (!existsSync(path)) return { kind: "missing" };
  try {
    return { kind: "ok", value: JSON.parse(readFileSync(path, "utf8")) as T };
  } catch {
    return { kind: "corrupt" };
  }
}

function writeJson(path: string, value: unknown): void {
  // 0600：订阅表里有 endpoint 和加密密钥，VAPID 私钥更不能给别人看
  writeJsonAtomic(path, value, { mode: 0o600 });
}

export class PushHub implements PushPort {
  #dataDir: string;
  #isWatched: (conversationId: number | undefined) => boolean;
  #keys: VapidKeys | undefined;
  #subs = new Map<string, PushSubscriptionRecord>();
  #enabled: boolean;

  constructor(options: PushHubOptions) {
    const config = loadConfig();
    this.#dataDir = options.dataDir;
    this.#isWatched = options.isWatched ?? (() => false);
    this.#enabled = config.pushEnabled;

    this.#keys = this.#loadOrCreateKeys();
    if (this.#keys && this.#enabled) {
      webpush.setVapidDetails(config.vapidSubject, this.#keys.publicKey, this.#keys.privateKey);
    } else if (!this.#keys && config.pushEnabled) {
      // 密钥文件坏了：这一次不推送，但**不覆盖**它 —— 留着还能人工救回来。
      // 同时把 enabled 置 false：没有 setVapidDetails 就调 sendNotification 会直接抛错，
      // 而且前端看到 enabled:false 就不会再去要订阅。
      this.#enabled = false;
      console.warn(
        `  ⚠ 推送密钥文件 ${join(this.#dataDir, VAPID_FILE)} 解析失败，本次启动不启用推送。\n` +
          "    不要直接删它：删掉会换新的密钥对，所有设备都要重新订阅。\n" +
          "    先确认文件内容（应为 {\"publicKey\":\"...\",\"privateKey\":\"...\"}），修好再重启。",
      );
    }

    const stored = readJson<PushSubscriptionRecord[]>(join(this.#dataDir, SUBS_FILE)) ?? [];
    for (const record of stored) this.#subs.set(record.endpoint, record);
  }

  get enabled(): boolean {
    return this.#enabled && this.#keys !== undefined;
  }

  /** 浏览器订阅前要先拿到这把公钥（`applicationServerKey`）。 */
  get publicKey(): string {
    return this.#keys?.publicKey ?? "";
  }

  /**
   * 读已有的 VAPID 密钥；只有**确认文件不存在**时才生成新的。
   * 返回 undefined = 文件坏了，调用方应当关掉推送而不是重建密钥。
   */
  #loadOrCreateKeys(): VapidKeys | undefined {
    const path = join(this.#dataDir, VAPID_FILE);
    const state = readJsonWithState<VapidKeys>(path);

    if (state.kind === "corrupt") return undefined;
    if (state.kind === "ok") {
      const { publicKey, privateKey } = state.value ?? {};
      if (publicKey && privateKey) return { publicKey, privateKey };
      // 能解析成 JSON 但字段不全，同样视为坏文件
      return undefined;
    }

    const generated = webpush.generateVAPIDKeys();
    const keys: VapidKeys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
    writeJson(path, keys);
    return keys;
  }

  #persist(): void {
    writeJson(join(this.#dataDir, SUBS_FILE), [...this.#subs.values()]);
  }

  /** 同一个 endpoint 重复订阅只更新（浏览器刷新时会给同一个 endpoint）。 */
  subscribe(input: { endpoint?: unknown; keys?: unknown }, conversationId?: number): boolean {
    const endpoint = typeof input.endpoint === "string" ? input.endpoint : "";
    const keys = input.keys as { p256dh?: unknown; auth?: unknown } | undefined;
    if (!endpoint || typeof keys?.p256dh !== "string" || typeof keys?.auth !== "string") return false;

    this.#subs.set(endpoint, {
      endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      conversationId,
      addedAt: this.#subs.get(endpoint)?.addedAt ?? Date.now(),
    });
    this.#persist();
    return true;
  }

  unsubscribe(endpoint: string): boolean {
    const removed = this.#subs.delete(endpoint);
    if (removed) this.#persist();
    return removed;
  }

  list(): readonly PushSubscriptionRecord[] {
    return [...this.#subs.values()];
  }

  /** 推送一条。404/410 = 订阅死了，删掉；其他错误只计数，不影响调用方。 */
  async notify(payload: PushPayload): Promise<PushResult> {
    const result: PushResult = { sent: 0, pruned: 0, failed: 0 };
    if (!this.#enabled || this.#subs.size === 0) return result;
    if (this.#isWatched(payload.conversationId)) return result;

    const body = JSON.stringify({
      id: randomUUID(),
      title: payload.title,
      body: payload.body,
      conversationId: payload.conversationId,
      tag: payload.tag,
      at: Date.now(),
    });

    await Promise.all(
      [...this.#subs.values()].map(async (record) => {
        try {
          await webpush.sendNotification(
            { endpoint: record.endpoint, keys: record.keys },
            body,
            { TTL: 300 },
          );
          result.sent += 1;
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            this.#subs.delete(record.endpoint);
            result.pruned += 1;
          } else {
            result.failed += 1;
            console.warn(`  push 失败 (${status ?? "?"}): ${(error as Error).message.slice(0, 120)}`);
          }
        }
      }),
    );

    if (result.pruned > 0) this.#persist();
    return result;
  }
}
