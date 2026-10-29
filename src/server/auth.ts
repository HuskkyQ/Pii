/**
 * 令牌鉴权 —— 只在「要把 pii 暴露到公网」时才需要。
 *
 * 为什么必须有：pii 能跑 bash / 改文件。挂到公网却不加锁，等于把你 Mac 的
 * 终端交给任何拿到 URL 的人。审批卡片是第二道门，但它防不了「别人替你按允许」。
 *
 * 默认关闭（PII_AUTH=1 才开）。开启后：
 *   1. 首次启动生成 32 字节随机令牌，落在 `<数据目录>/auth-token`（0600）
 *   2. 浏览器访问任何页面都会被重定向到 /login
 *   3. 输入令牌 → 种 cookie（HttpOnly、SameSite=Lax；https 下再加 Secure，一年有效）
 *   4. 也可以直接用 `/?token=xxx` 这种链接进（方便手机上点一次）
 *
 * 为什么用 cookie 而不是 header：这样**前端一行都不用改**。
 * fetch 和 EventSource 同源请求默认都带 cookie；而 iOS 的「添加到主屏幕」
 * 跟 Safari 的存储是分开的，所以在独立窗口里点一次登录就够了。
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Context } from "hono";

const COOKIE = "pii_token";
const TOKEN_FILE = "auth-token";

function readOrCreateToken(dataDir: string): string {
  const path = join(dataDir, TOKEN_FILE);
  if (existsSync(path)) {
    const value = readFileSync(path, "utf8").trim();
    if (value) return value;
  }
  const token = randomBytes(32).toString("base64url");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return token;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // 长度不同直接判否；长度相同才做等时比较（防时序侧信道）
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface Auth {
  enabled: boolean;
  token: string;
  /** 这个请求带没带有效凭证 */
  allowed(c: Context): boolean;
  /** 从 URL / 表单拿到的令牌是否正确 */
  matches(candidate: string | undefined): boolean;
  /** 种 cookie 用（https 下才加 Secure） */
  cookieFor(c: Context): string;
  loginPage(next: string, failed: boolean): string;
}

export function createAuth(dataDir: string): Auth {
  const enabled = process.env.PII_AUTH === "1" || Boolean(process.env.PII_TOKEN);
  const token = enabled ? (process.env.PII_TOKEN ?? readOrCreateToken(dataDir)) : "";

  // 失败几次就慢下来，免得公网上被暴力猜
  let failures = 0;

  const matches = (candidate: string | undefined): boolean => {
    if (!enabled) return true;
    if (!candidate) return false;
    const ok = safeEqual(candidate, token);
    failures = ok ? 0 : failures + 1;
    return ok;
  };

  return {
    enabled,
    token,
    matches,

    allowed(c: Context): boolean {
      if (!enabled) return true;
      const cookie = c.req.header("cookie") ?? "";
      for (const part of cookie.split(";")) {
        const [name, ...rest] = part.trim().split("=");
        if (name === COOKIE) {
          const value = decodeURIComponent(rest.join("="));
          if (safeEqual(value, token)) return true;
          break;
        }
      }
      const header = c.req.header("authorization");
      if (header?.startsWith("Bearer ") && safeEqual(header.slice(7), token)) return true;
      const query = c.req.query("token");
      return query ? safeEqual(query, token) : false;
    },

    cookieFor(c: Context): string {
      const secure = c.req.header("x-forwarded-proto") === "https" || c.req.url.startsWith("https://");
      const parts = [
        `${COOKIE}=${encodeURIComponent(token)}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        "Max-Age=31536000",
      ];
      if (secure) parts.push("Secure");
      return parts.join("; ");
    },

    loginPage(next: string, failed: boolean): string {
      const hint = failed
        ? `<p class="err">令牌不对${failures > 2 ? "（连续失败会变慢，防止被暴力猜）" : ""}</p>`
        : "";
      return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="theme-color" content="#161a21">
<title>pii · 登录</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100dvh; display:grid; place-items:center; background:#161a21; color:#e7e9ee;
         font: 14px/1.5 -apple-system, system-ui, "PingFang SC", sans-serif; padding:24px; }
  form { width:100%; max-width:340px; }
  h1 { font-size:16px; margin:0 0 4px; font-weight:600; }
  p  { margin:0 0 16px; color:#8b91a0; font-size:12.5px; }
  input { width:100%; box-sizing:border-box; padding:11px 12px; border-radius:10px; font-size:15px;
          background:#1d222b; color:#e7e9ee; border:1px solid #2c333f; outline:none; }
  input:focus { border-color:#4b5563; }
  button { margin-top:10px; width:100%; padding:11px; border:0; border-radius:10px; font-size:14px;
           background:#e7e9ee; color:#161a21; font-weight:600; }
  .err { color:#f87171; font-size:12px; margin:0 0 12px; }
</style>
</head><body>
<form method="post" action="/login">
  <h1>pii</h1>
  <p>输入访问令牌（在 Mac 上执行 <code>cat ~/.pii/auth-token</code> 查看）</p>
  ${hint}
  <input name="token" type="password" autocomplete="current-password" autofocus placeholder="令牌">
  <input type="hidden" name="next" value="${next.replace(/"/g, "&quot;")}">
  <button type="submit">进入</button>
</form>
</body></html>`;
    },
  };
}
