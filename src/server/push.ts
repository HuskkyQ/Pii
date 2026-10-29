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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import webpush from "web-push";

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** 订阅时正在看哪个会话；推送里带回去，点通知能跳对地方。 */
  conversationId?: number;
  addedAt: number;
}

export interface PushPayload {
  title: string;
  body: string;
  conversationId?: number;
  /** 同一个 tag 的新通知会替换旧的（别让一条会话刷出 10 条） */
  tag?: string;
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

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
}

export class PushHub {
  #dataDir: string;
  #isWatched: (conversationId: number | undefined) => boolean;
  #keys: VapidKeys;
  #subs = new Map<string, PushSubscriptionRecord>();
  #enabled: boolean;

  constructor(options: PushHubOptions) {
    this.#dataDir = options.dataDir;
    this.#isWatched = options.isWatched ?? (() => false);
    this.#enabled = process.env.PII_PUSH !== "0";

    this.#keys = this.#loadOrCreateKeys();
    if (this.#enabled) {
      webpush.setVapidDetails(
        process.env.PII_VAPID_SUBJECT ?? "mailto:pii@localhost",
        this.#keys.publicKey,
        this.#keys.privateKey,
      );
    }

    const stored = readJson<PushSubscriptionRecord[]>(join(this.#dataDir, SUBS_FILE)) ?? [];
    for (const record of stored) this.#subs.set(record.endpoint, record);
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** 浏览器订阅前要先拿到这把公钥（`applicationServerKey`）。 */
  get publicKey(): string {
    return this.#keys.publicKey;
  }

  #loadOrCreateKeys(): VapidKeys {
    const path = join(this.#dataDir, VAPID_FILE);
    const stored = readJson<VapidKeys>(path);
    if (stored?.publicKey && stored?.privateKey) return stored;

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
