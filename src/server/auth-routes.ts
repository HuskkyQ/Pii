/**
 * 登录、登出、鉴权中间件。
 *
 * 整段原本包在 main.ts 的 `if (auth.enabled) { ... }` 里；是否启用由
 * main.ts 判断后调用本函数，内部不再自己判断。注册顺序由 main.ts 控制，
 * 必须排在所有业务路由之前（否则未登录请求会先命中业务路由）。
 */
import type { Context, Hono } from "hono";

import { COOKIE_TTL_WEEK, type LoginMode } from "./auth.ts";
import type { AppContext } from "./context.ts";

/**
 * 鉴权（PII_AUTH=1 或 PII_TOKEN=... 时生效；默认关）。
 *
 * 放行清单只包含「装上主屏幕 + 收推送」必需的东西：
 * manifest / service worker / 图标 / 带指纹的静态资源。
 * 这些不含任何数据，泄露了也没关系；真正的数据和操作都在 /api/* 后面。
 */
/**
 * 登录失败限速：按客户端 IP 记「错了几次 / 锁到什么时候」。
 *
 * 为什么按 IP 而不是一个全局计数：全局计数等于给了别人一把锁 ——
 * 故意错几次就能把你关在门外（拒绝服务）。
 *
 * 为什么光有延时不够、还要真锁：`setTimeout` 是**每个请求各睡各的**。
 * 开 20 条并发连接，「每次等 1.5 秒」立刻被摊成 13 次/秒。真正的阻力来自
 * 「第 6 次起锁 5 分钟」，睡眠只是让暴力猜变慢，不是防线本身。
 *
 * 为什么不落库：登录失败记录是短命数据，重启后清零可以接受。
 */
const LOGIN_FREE_TRIES = 5; // 前 5 次只退避，不锁
const LOGIN_LOCK_MS = 5 * 60_000; // 第 6 次失败起锁 5 分钟
const MAX_TRACKED_IPS = 1000; // 失败表的容量上限（见下面淘汰逻辑）
const loginFailures = new Map<string, { n: number; lockUntil: number }>();

/**
 * 直接求当前连接的 socket 地址 —— 这是唯一**伪造不了**的值。
 *
 * `X-Forwarded-For` 是普通请求头，谁都能写；socket 地址由内核填充，客户端改不了。
 * 所以只要能拿到它，就以它为准。
 */
function peerIp(c: Context): string {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  const raw = env?.incoming?.socket?.remoteAddress ?? "";
  // IPv4-mapped（::ffff:127.0.0.1）统一成 v4 写法，让下面的比较不用写两套
  return raw.replace(/^::ffff:/, "");
}

/**
 * 取真实客户端 IP，给登录限速当 key。
 *
 * 唯一**不能**做的事是相信头里的第一段：客户端自己就能往 `X-Forwarded-For` 里塞任意内容，
 * 反向代理只会在后面**追加**它看到的对端地址。取 `[0]` 等于把限速的钥匙交给攻击者 ——
 * 每次换一个假 IP 就永远触发不了锁定，还能顺带把 scrypt 的 CPU 打满。
 *
 * 所以分两种情况：
 *   1. 对端是同机（127.0.0.1 / ::1）→ 前面一定站着本机代理（Caddy），
 *      取 `X-Forwarded-For` 的**最后一段**。代理追加、代理覆盖两种行为下末尾都是真实 IP。
 *   2. 对端是外网 / 局域网 / tailscale → 没有代理，直接连过来的就是真身，
 *      用 socket 地址，头里写什么都无视。
 */
function clientIp(c: Context): string {
  const peer = peerIp(c);
  const forwarded = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "";
  const lastHop = forwarded.split(",").at(-1)?.trim() ?? "";
  const behindLocalProxy = peer === "" || peer === "127.0.0.1" || peer === "::1";
  if (behindLocalProxy && lastHop) return lastHop;
  return peer || "direct";
}

/**
 * 登录成功后允许跳回的地址：只接受站内相对路径。
 *
 * `startsWith("/")` 是不够的 —— `//evil.example` 也以 `/` 开头，而
 * `Location: //evil.example` 会让浏览器跳到外站（协议相对 URL）。
 * 反斜杠在部分浏览器里等价于斜杠，所以 `/\evil.example` 也要拦。
 */
function safeNext(value: unknown): string {
  if (typeof value !== "string") return "/";
  const v = value.trim();
  if (!v.startsWith("/")) return "/";
  if (v.startsWith("//") || v.startsWith("/\\")) return "/";
  // 控制字符（含 \r \n）能截断 Location 头，一律拒绝
  if (/[\u0000-\u001f\u007f]/.test(v)) return "/";
  return v;
}


export function registerAuth(app: Hono, ctx: AppContext): void {
  const { auth } = ctx;

  const PUBLIC = [
    "/login",
    "/manifest.webmanifest",
    "/sw.js",
    "/favicon.ico",
    "/favicon.svg",
    "/favicon-32.png",
    "/icon.svg",
    "/apple-touch-icon.png",
  ];
  const isPublic = (path: string) =>
    PUBLIC.includes(path) || path.startsWith("/icons/") || path.startsWith("/assets/");

  app.get("/login", (c) => {
    const token = c.req.query("token");
    if (auth.matches(token)) {
      // 带 token 的链接：种 cookie 后回首页
      c.header("Set-Cookie", auth.cookieFor(c));
      return c.redirect("/");
    }
    return c.html(auth.loginPage({ next: "/" }));
  });

  app.post("/login", async (c) => {
    const body = (await c.req.parseBody().catch(() => ({}))) as {
      token?: string;
      user?: string;
      pass?: string;
      next?: string;
    };
    const next = safeNext(body.next);
    // 失败后要停在原来那一栏：提交了 user/pass 就是密码栏，否则是令牌栏
    const mode: LoginMode = typeof body.user === "string" || typeof body.pass === "string" ? "pw" : "token";

    const ip = clientIp(c);
    const entry = loginFailures.get(ip) ?? { n: 0, lockUntil: 0 };
    if (Date.now() < entry.lockUntil) {
      // 锁定期内连凭证都不比对：既不耗 CPU，也不给对方「猜对/猜错」的时序线索
      const wait = Math.ceil((entry.lockUntil - Date.now()) / 1000);
      return c.html(
        auth.loginPage({ next, failed: true, mode, note: `尝试过于频繁，请 ${wait} 秒后再试` }),
        429,
      );
    }

    // ① 令牌 → cookie 一年（行为与以前完全一致，含 /?token= 链路）
    if (auth.matches(typeof body.token === "string" ? body.token.trim() : undefined)) {
      loginFailures.delete(ip);
      c.header("Set-Cookie", auth.cookieFor(c));
      return c.redirect(next);
    }

    // ② 账号密码 → cookie 七天（人定的密码熵低，短一点更稳）
    if (auth.checkPassword(body.user, body.pass)) {
      loginFailures.delete(ip);
      c.header("Set-Cookie", auth.cookieFor(c, COOKIE_TTL_WEEK));
      return c.redirect(next);
    }

    // ③ 失败：累加 → 超限锁定 → 否则指数退避（1s / 2s / 4s / 8s 封顶）
    entry.n += 1;
    if (entry.n > LOGIN_FREE_TRIES) entry.lockUntil = Date.now() + LOGIN_LOCK_MS;
    // 先删再设：Map 保留插入顺序，重复 set 不会刷新位置，
    // 不这么做的话「还在挨打的老 IP」最容易被下面的淘汰逻辑选中。
    loginFailures.delete(ip);
    loginFailures.set(ip, entry);
    // Map 不能无限长，但**绝不能整体清空**：清空一次就等于给攻击者一个「重置所有锁定」
    // 的开关（刷 1001 个来源即可解锁，连已经锁住的那些人一起放过）。
    // 改成按插入顺序淘汰最老的一批，现有锁定记录尽量保住。
    if (loginFailures.size > MAX_TRACKED_IPS) {
      for (const key of loginFailures.keys()) {
        if (loginFailures.size <= MAX_TRACKED_IPS - 200) break;
        loginFailures.delete(key);
      }
    }

    if (entry.n > LOGIN_FREE_TRIES) {
      return c.html(
        auth.loginPage({ next, failed: true, mode, note: "连续失败过多，已锁定 5 分钟" }),
        429,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(8, 2 ** (entry.n - 1)) * 1000));
    return c.html(auth.loginPage({ next, failed: true, mode }), 401);
  });

  /**
   * 退出登录：把 cookie 清掉，再回登录页。
   *
   * 三条路都留着，因为退出登录的代价不一样：
   *   GET  /logout      地址栏能敲、书签能存、JS 坏了也能用（手机上最需要这条）
   *   POST /logout      表单/按钮用，不带副作用语义上的争议
   *   POST /api/logout  前端按钮用，回 JSON，由前端决定跳哪儿
   *
   * GET 有副作用在理论上是缺点（别人的网页放个 `<img src="/logout">` 就能把你踢下线），
   * 但退出的最坏结果只是重输一次密码 —— 为它加 CSRF 令牌不值。
   *
   * 注意这三条都注册在下面的鉴权中间件**之前**：cookie 已经过期的人也得能点退出，
   * 否则他会卡在「登录页 + 一个删不掉的旧 cookie」之间。
   */
  const logout = (c: Context) => {
    c.header("Set-Cookie", auth.clearCookie(c));
    return c.redirect("/login");
  };
  app.get("/logout", logout);
  app.post("/logout", logout);
  app.post("/api/logout", (c) => {
    c.header("Set-Cookie", auth.clearCookie(c));
    return c.json({ ok: true });
  });

  app.use("*", async (c, next) => {
    const path = c.req.path;
    if (isPublic(path) || auth.allowed(c)) return next();

    // API / SSE 一律 401 JSON，前端能识别并提示登录
    if (path.startsWith("/api/")) {
      return c.json({ error: "未登录，先访问 /login 输入令牌" }, 401);
    }
    // 页面请求：直接给登录页（独立窗口里也能用，不需要地址栏）
    return c.html(auth.loginPage({ next: path }), 401);
  });

/**
 * 前端用它决定状态栏要不要显示「退出登录」。
 *
 * 为什么不让前端自己猜：没开鉴权时 /logout 压根没注册（没有 cookie 可清），
 * 点了只会 404。这个问题只有服务端答得准。
 */
app.get("/api/auth", (c) => c.json({ enabled: auth.enabled, password: auth.passwordEnabled }));
}
