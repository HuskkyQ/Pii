/**
 * pii 的 service worker。
 *
 * 做三件事：
 *  1. 让页面可安装（有 fetch handler 的 SW 是安装前提）
 *  2. 离线时给一个壳页面，不让用户看到浏览器默认错误页
 *  3. 收 Web Push：弹出通知，点一下回到对应会话
 *
 * 明确不做的事：**不缓存 /api/**。
 * 会话数据必须永远走网络 —— 快照是权威，缓存会让界面显示过期状态。
 */
const VERSION = "pii-v5";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      await cache.addAll(SHELL).catch(() => undefined);

      /*
       * 把首页引用的「带指纹资源」一并预缓存。
       *
       * 为什么必须做：SW 只缓存「经过它的请求」。首次安装时，JS/CSS 是在 SW 激活
       * **之前**加载的，所以它们不在缓存里 —— 第二次打开仍要重新下载 600KB。
       * 这里读一次首页 HTML、抠出 /assets/... 的地址，主动 addAll 进缓存，
       * 之后每次冷启动都是 0 网络字节。
       */
      try {
        const shell = (await cache.match("/")) ?? (await fetch("/", { cache: "no-store" }));
        if (shell && shell.ok) {
          const html = await shell.clone().text();
          const urls = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
          if (urls.length > 0) await cache.addAll(urls);
        }
      } catch {
        /* 预缓存失败不影响使用，只是下次打开要多走一次网络 */
      }

      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // API 和 SSE 一律直连，绝不缓存
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (request.method !== "GET") return;

  /*
   * 导航请求：**缓存优先 + 后台更新**（stale-while-revalidate）。
   *
   * 以前是「网络优先」：每次打开都要先等一个来回（Funnel 的入口在境外，
   * RTT 几百毫秒，冷启动白屏 3~4 秒就是等它）。改成先给缓存的壳、同时后台拉新版本，
   * 打开速度就从「一个网络来回」变成「读一次磁盘」。
   *
   * 为什么安全：壳只是一个引用带指纹资源的 HTML。旧壳引旧资源，而旧资源也缓存在
   * 这里，照样能跑；下次打开就换成新的了。数据永远是 /api 实时拉的，不受影响。
   */
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(VERSION);
        const cached = await cache.match("/");

        const network = fetch(request)
          .then((response) => {
            // 只缓存真正成功的页面；登录页（401）和错误页不能进缓存
            if (response.ok && response.status === 200) {
              void cache.put("/", response.clone());
            }
            return response;
          })
          .catch(() => null);

        if (cached) {
          void network; // 后台更新，不阻塞
          return cached;
        }
        return (await network) ?? new Response("离线", { status: 503 });
      })(),
    );
    return;
  }

  // 静态资源：缓存优先（带指纹的文件名，安全）
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ??
        fetch(request).then((response) => {
          if (response.ok && url.pathname.startsWith("/assets/")) {
            const copy = response.clone();
            void caches.open(VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});

/**
 * Web Push。
 *
 * 这里有一件事必须记住：**SW 里不能用 window**。
 * 想「点通知就聚焦到某个标签页」只能 `clients.matchAll()` + `client.focus()`。
 */
self.addEventListener("push", (event) => {
  let payload = { title: "pii", body: "有新动静", conversationId: undefined, tag: undefined };
  try {
    payload = { ...payload, ...(event.data ? event.data.json() : {}) };
  } catch {
    /* 非 JSON 的 payload 就用默认文案，不要因为解析失败把通知丢掉 */
  }

  const url = payload.conversationId ? `/?c=${payload.conversationId}` : "/";
  event.waitUntil(
    self.registration.showNotification(payload.title || "pii", {
      body: payload.body || "",
      tag: payload.tag,
      data: { url, conversationId: payload.conversationId },
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      // 同 tag 的新通知替换旧的（正在跑的那个会话不该刷出 10 条）
      renotify: Boolean(payload.tag),
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? "/";

  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // 已经开着同一个会话 → 只聚焦，不动地址
      for (const client of all) {
        const same = new URL(client.url).search === new URL(url, self.location.origin).search;
        if (same) return client.focus();
      }
      // 开着别的会话 → 把它导航过去（比新开一个标签页更符合「回到那个会话」）
      const anyWindow = all.find((client) => "navigate" in client);
      if (anyWindow) {
        await anyWindow.focus();
        return anyWindow.navigate(url);
      }
      return self.clients.openWindow(url);
    })(),
  );
});
