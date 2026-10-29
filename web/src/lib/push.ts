/**
 * Web Push 的浏览器侧。
 *
 * 三个前提，缺一个就整条路走不通：
 *  1. **安全上下文** —— https 或 localhost。手机上 http://192.168.x.x 不行。
 *  2. **service worker 已激活** —— 推送是 SW 收到的，页面只是代理人。
 *  3. **通知权限 = granted** —— 必须由用户手势触发 `requestPermission()`。
 *
 * iOS 还多一条：16.4 起才支持，而且必须「添加到主屏幕」后从图标进入。
 */
import { getJson, postJson } from "./api";

interface PushKeyResponse {
  publicKey: string;
  enabled: boolean;
}

export type PushState = "unsupported" | "denied" | "subscribed" | "ready";

/** VAPID 公钥是 base64url，`pushManager.subscribe` 要 Uint8Array。 */
function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function pushSupported(): boolean {
  return (
    import.meta.env.PROD &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window &&
    window.isSecureContext
  );
}

async function activeRegistration(): Promise<ServiceWorkerRegistration> {
  // 只在生产注册 SW（见 main.tsx），开发环境这里会一直等到超时 —— 所以先挡一下
  if (!pushSupported()) throw new Error("这个环境不支持推送（需要 https/localhost + 生产构建）");
  return navigator.serviceWorker.ready;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await activeRegistration();
  return registration.pushManager.getSubscription();
}

export async function readPushState(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const subscription = await currentSubscription().catch(() => null);
  return subscription ? "subscribed" : "ready";
}

/** 申请权限 + 订阅 + 上报服务端。必须从点击事件里调用（Safari 的硬要求）。 */
export async function enablePush(conversationId?: number): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("通知权限没有给");

  const { publicKey, enabled } = await getJson<PushKeyResponse>("/api/push/key");
  if (!enabled) throw new Error("服务端关掉了推送（PII_PUSH=0）");

  const registration = await activeRegistration();
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    }));

  await postJson("/api/push/subscribe", { ...subscription.toJSON(), conversationId });
}

/** 退订：先在服务端删（免得留死信箱），再让浏览器取消。 */
export async function disablePush(): Promise<void> {
  const subscription = await currentSubscription().catch(() => null);
  if (!subscription) return;
  await postJson("/api/push/unsubscribe", { endpoint: subscription.endpoint }).catch(() => {
    /* 服务端可能已经不认识了，继续在浏览器侧取消 */
  });
  await subscription.unsubscribe();
}
