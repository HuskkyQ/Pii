/**
 * 令牌 / 账号密码鉴权 —— 只在「要把 pii 暴露到公网」时才需要。
 *
 * 为什么必须有：pii 能跑 bash / 改文件。挂到公网却不加锁，等于把你 Mac 的
 * 终端交给任何拿到 URL 的人。审批卡片是第二道门，但它防不了「别人替你按允许」。
 *
 * 默认关闭（PII_AUTH=1 或 PII_TOKEN=... 才开）。开启后两种登录方式并存：
 *
 *   ① 令牌（最早的那套，行为完全不变）
 *      - 首次启动生成 32 字节随机令牌，落在 `<数据目录>/auth-token`（0600）
 *      - cookie 有效期 **一年**：机器生成的密钥有 256 位熵，泄露风险低，图省事
 *      - 也支持 `/?token=xxx` 链接（手机上点一次就进）
 *
 *   ② 账号密码（额外配了 PII_USER + PII_PASS_HASH 才出现）
 *      - 密码只存 scrypt 哈希（`npm run hash-pass` 生成），明文永不落盘
 *      - cookie 有效期 **七天**：人定的密码熵比机器密钥低，短一点更稳
 *
 * 两种方式种的是**同一个 cookie**，只是 Max-Age 不同 —— 这样前端一行都不用改。
 * （详见 main.ts 里 POST /login 的两条分支）
 *
 * 失败限速**不在这里做**：退避要按客户端 IP 记账，而 auth 是全局单例、不认识
 * 请求来源。按 IP 的指数退避 + 锁定统一放在 main.ts 的 POST /login。
 *
 * 为什么用 cookie 而不是 header：这样**前端一行都不用改**。
 * fetch 和 EventSource 同源请求默认都带 cookie；而 iOS 的「添加到主屏幕」
 * 跟 Safari 的存储是分开的，所以在独立窗口里点一次登录就够了。
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Context } from "hono";

const COOKIE = "pii_token";
const TOKEN_FILE = "auth-token";

/** 令牌登录：一年（机器生成的高熵密钥，图省事） */
export const COOKIE_TTL_YEAR = 365 * 24 * 60 * 60;
/** 账号密码登录：七天（人定的密码熵低，短一点） */
export const COOKIE_TTL_WEEK = 7 * 24 * 60 * 60;

/** 登录页默认显示哪个 Tab：配了账号密码就优先它，否则退回令牌 */
export type LoginMode = "pw" | "token";

export interface LoginPageOptions {
  /** 登录成功后回哪儿（只接受站内路径） */
  next: string;
  /** 上一次是不是失败了（显示红字） */
  failed?: boolean;
  /** 上次用的是哪一栏（失败时要停在原来那栏，不要跳走） */
  mode?: LoginMode;
  /** 附加一句提示，例如「尝试过于频繁，请 42 秒后再试」 */
  note?: string;
}

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

/** 把用户输入塞进 HTML 属性/文本前先转义 */
function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface Auth {
  enabled: boolean;
  token: string;
  /** 是否额外开了账号密码登录（PII_USER + PII_PASS_HASH 都配了） */
  passwordEnabled: boolean;
  /** 这个请求带没带有效凭证 */
  allowed(c: Context): boolean;
  /** 从 URL / 表单拿到的令牌是否正确 */
  matches(candidate: string | undefined): boolean;
  /** 账号密码是否正确（没配账号密码时永远 false） */
  checkPassword(candidateUser: unknown, candidatePass: unknown): boolean;
  /** 种 cookie 用（https 下才加 Secure；maxAge 默认一年） */
  cookieFor(c: Context, maxAge?: number): string;
  loginPage(opts: LoginPageOptions): string;
}

export function createAuth(dataDir: string): Auth {
  const enabled = process.env.PII_AUTH === "1" || Boolean(process.env.PII_TOKEN);
  const token = enabled ? (process.env.PII_TOKEN ?? readOrCreateToken(dataDir)) : "";

  const user = (process.env.PII_USER ?? "").trim();
  const passHash = (process.env.PII_PASS_HASH ?? "").trim();
  const passwordEnabled = enabled && Boolean(user && passHash);

  // 令牌提示里该敲哪条命令：默认指向真实数据目录，服务器上可用 PII_TOKEN_HINT 覆盖
  const tokenHint = (process.env.PII_TOKEN_HINT ?? "").trim() || `cat ${join(dataDir, TOKEN_FILE)}`;

  /** scrypt 校验。哈希格式：scrypt$<saltBase64>$<hashBase64>（脚本见 scripts/hash-password.mjs） */
  const verifyPassword = (plain: string): boolean => {
    const parts = passHash.split("$");
    if (parts.length !== 3 || parts[0] !== "scrypt") return false;
    const salt = Buffer.from(parts[1] ?? "", "base64");
    const expected = Buffer.from(parts[2] ?? "", "base64");
    if (salt.length === 0 || expected.length === 0) return false;
    // scryptSync 默认 N=16384, r=8, p=1（内存约 16MB），对登录场景足够
    return timingSafeEqual(scryptSync(plain, salt, expected.length), expected);
  };

  const matches = (candidate: string | undefined): boolean => {
    if (!enabled) return true;
    if (!candidate) return false;
    return safeEqual(candidate, token);
  };

  return {
    enabled,
    token,
    passwordEnabled,
    matches,

    checkPassword(candidateUser: unknown, candidatePass: unknown): boolean {
      if (!passwordEnabled) return false;
      if (typeof candidateUser !== "string" || typeof candidatePass !== "string") return false;
      // 用户名不对外做提示，错了也走一遍等时比较再判否
      if (!safeEqual(candidateUser.trim(), user)) return false;
      return verifyPassword(candidatePass);
    },

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

    cookieFor(c: Context, maxAge: number = COOKIE_TTL_YEAR): string {
      const secure = c.req.header("x-forwarded-proto") === "https" || c.req.url.startsWith("https://");
      const parts = [
        `${COOKIE}=${encodeURIComponent(token)}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        `Max-Age=${maxAge}`,
      ];
      if (secure) parts.push("Secure");
      return parts.join("; ");
    },

    loginPage({ next, failed, mode, note }: LoginPageOptions): string {
      // 没配账号密码时永远只显示令牌栏 —— 老部署行为一字不变
      const active: LoginMode = passwordEnabled ? (mode ?? "pw") : "token";
      const wrong = active === "pw" ? "用户名或密码不对" : "令牌不对";
      const errHtml = failed ? `<p class="err">${wrong}${note ? `（${esc(note)}` + "）" : ""}</p>` : "";

      const tokenForm = `<form class="pane" id="pane-token" method="post" action="/login">
  <p>${passwordEnabled ? "访问令牌" : "输入访问令牌"}（在服务器上执行 <code>${esc(tokenHint)}</code> 查看）</p>
  <input name="token" type="password" autocomplete="current-password"${active === "token" ? " autofocus" : ""} placeholder="令牌">
  <input type="hidden" name="next" value="${esc(next)}">
  <button type="submit">进入</button>
</form>`;

      const passwordForm = `<form class="pane" id="pane-pw" method="post" action="/login">
  <p>账号密码登录（登录后 7 天内免输）</p>
  <input name="user" type="text" autocomplete="username" autocapitalize="off" spellcheck="false"${active === "pw" ? " autofocus" : ""} placeholder="用户名">
  <input name="pass" type="password" autocomplete="current-password" placeholder="密码">
  <input type="hidden" name="next" value="${esc(next)}">
  <button type="submit">登录</button>
</form>`;

      // 两栏切换用纯 CSS 的 radio + 兄弟选择器：不引 JS，PWA 独立窗口里也能用
      const tabs = passwordEnabled
        ? `<input class="tab-radio" type="radio" name="mode" id="m-pw"${active === "pw" ? " checked" : ""}>
<input class="tab-radio" type="radio" name="mode" id="m-token"${active === "token" ? " checked" : ""}>
<div class="tabs">
  <label for="m-pw">账号密码</label>
  <label for="m-token">令牌</label>
</div>
${passwordForm}
${tokenForm}`
        : tokenForm;

      // 只有双栏时才需要「默认隐藏、选中才显示」的规则
      const paneCss = passwordEnabled
        ? `.pane{display:none}
#m-pw:checked ~ #pane-pw{display:block}
#m-token:checked ~ #pane-token{display:block}
.tab-radio{position:absolute;opacity:0;pointer-events:none}
.tabs{display:flex;gap:6px;margin:0 0 14px;padding:3px;background:#1d222b;border:1px solid #2c333f;border-radius:10px}
.tabs label{flex:1;text-align:center;padding:7px 0;border-radius:8px;font-size:12.5px;color:#8b91a0;cursor:pointer;user-select:none}
#m-pw:checked ~ .tabs label[for=m-pw],#m-token:checked ~ .tabs label[for=m-token]{background:#2c333f;color:#e7e9ee;font-weight:600}
.pane input + input{margin-top:10px}`
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
  code { font-size:12px; color:#c3c8d4; word-break:break-all; }
  input { width:100%; box-sizing:border-box; padding:11px 12px; border-radius:10px; font-size:15px;
          background:#1d222b; color:#e7e9ee; border:1px solid #2c333f; outline:none; }
  input:focus { border-color:#4b5563; }
  button { margin-top:10px; width:100%; padding:11px; border:0; border-radius:10px; font-size:14px;
           background:#e7e9ee; color:#161a21; font-weight:600; }
  .err { color:#f87171; font-size:12px; margin:0 0 12px; }
  .wrap { width:100%; max-width:340px; }
  ${paneCss}
</style>
</head><body>
<div class="wrap">
<h1>pii</h1>
${errHtml}
${tabs}
</div>
</body></html>`;
    },
  };
}
