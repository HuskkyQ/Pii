/**
 * 联网搜索：`web_search` + `web_fetch`。
 *
 * 为什么是两个工具而不是一个：搜索只返回「标题 + 链接 + 摘要」，正文要单独抓。
 * 一次搜索 8 条 × 3000 字 = 24000 字，其中 7 条是噪音；分成两步之后模型自己挑
 * 1-3 条去抓，同样的信息量只花 1/6 的 token。这就是 agentic retrieval。
 *
 * 两个供应商，按有没有 key 自动选：
 *  - 配了 `PII_SEARCH_KEY` → 博查 API（可调条数、有时间过滤、要钱）
 *  - 没配 → 必应 RSS（`cn.bing.com/search?...&format=rss`，免费、免注册、固定 10 条）
 * 必应这个不是官方 API：哪天改版或限流，结果是「报错 / 0 条」，不会静默编造。
 *
 * 三条纪律：
 *  1. **`web_search` 免审批**：只读、无副作用，一个任务里要调好几次。
 *     `web_fetch` 不在此列 —— 不在 KNOWN_TOOLS 里，默认每次问（见 policies.ts）。
 *  2. **`web_fetch` 必须挡内网**：容器里 `http://127.0.0.1:8443` 是 pii 自己，
 *     `169.254.169.254` 是云厂商元数据（能读到实例凭证）。域名可以解析到内网 IP，
 *     所以解析之后还要再查一次地址。
 *  3. **返回人话**：结果直接显示在界面上，用中文。
 */
import { lookup } from "node:dns/promises";

import { defineTool, defineExtension } from "@earendil-works/pi-durable";
import { lit, num, obj, opt, str, union } from "@earendil-works/pi-schema";

const SEARCH_ENDPOINT = "https://api.bochaai.com/v1/web-search";
/** 必应的 RSS 版搜索：免 key，但固定 10 条、没有时间过滤。 */
const BING_ENDPOINT = "https://cn.bing.com/search";
const BING_COUNT = 10;
const DEFAULT_COUNT = 8;
/** 比接口上限（50）小得多：每多一条就多几百字摘要。 */
const MAX_COUNT = 15;
const MAX_SNIPPET_CHARS = 500;
const MAX_RESULT_CHARS = 6000;
const MAX_FETCH_CHARS = 8000;
const MAX_BODY_BYTES = 2_000_000;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 15_000;
const UA = "Mozilla/5.0 (compatible; pii/0.1; +https://piihub.icu)";

export interface WebOptions {
  /** 博查 key。不传就用必应 RSS（免费，但固定 10 条、无时间过滤）。 */
  apiKey?: string;
  /** 测试用：替换掉全局 fetch。 */
  fetchImpl?: typeof fetch;
}

/* ------------------------------------------------------------ 类型帮助函数 */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…（已截断，原文 ${text.length} 字）`;
}

/* -------------------------------------------------------------- 搜索结果解析 */

export interface SearchHit {
  title: string;
  url: string;
  site?: string;
  date?: string;
  snippet: string;
}

/**
 * 博查的返回是 Bing Search API 的形状：
 * `{ code: 200, data: { webPages: { value: [{ name, url, snippet, summary, siteName, datePublished }] } } }`
 * 每层都做存在性检查 —— 换供应商或接口改版时应该返回「没搜到」，而不是抛异常。
 */
export function parseSearchHits(json: unknown): SearchHit[] {
  const value = asRecord(asRecord(asRecord(json)?.data)?.webPages)?.value;
  if (!Array.isArray(value)) return [];

  const hits: SearchHit[] = [];
  for (const raw of value) {
    const item = asRecord(raw);
    const url = asString(item?.url);
    if (!item || !url) continue;
    const site = asString(item.siteName);
    const date = asString(item.datePublished) ?? asString(item.dateLastCrawled);
    hits.push({
      title: asString(item.name) ?? url,
      url,
      ...(site ? { site } : {}),
      ...(date ? { date } : {}),
      snippet: (asString(item.summary) ?? asString(item.snippet) ?? "").trim(),
    });
  }
  return hits;
}

/** 给模型看的文本：编号 + 标题 + 链接 + 摘要。末尾提示它去抓正文。 */
export function formatHits(query: string, hits: SearchHit[]): string {
  if (hits.length === 0) return `没有搜到结果（query: ${query}）。换个关键词再试。`;

  const parts: string[] = [`搜索「${query}」共 ${hits.length} 条：`];
  let used = parts[0]!.length;

  for (const [index, hit] of hits.entries()) {
    const snippet = truncate(hit.snippet, MAX_SNIPPET_CHARS);
    const meta = [hit.site, hit.date].filter(Boolean).join(" · ");
    const block =
      `\n[${index + 1}] ${hit.title}\n${hit.url}` +
      (meta ? `\n${meta}` : "") +
      (snippet ? `\n${snippet}` : "");
    if (used + block.length > MAX_RESULT_CHARS) break;
    parts.push(block);
    used += block.length;
  }

  parts.push("\n\n（以上只有摘要。要读正文，用 web_fetch 打开其中 1-3 个链接。）");
  return parts.join("");
}

/* ---------------------------------------------------------------- HTML → 文本 */

/** 剥标签取正文。不引 cheerio：一个正则够用，还省一层依赖。 */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre|table)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&") // 最后再解 &amp;，否则 &amp;lt; 会变成 <
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ------------------------------------------------------------- 必应 RSS 解析 */

/** 解 XML 实体。&amp; 放最后，否则 `&amp;lt;` 会被解成 `<`。 */
export function decodeXml(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function tagOf(xml: string, name: string): string {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  return match ? match[1]!.trim() : "";
}

/** `周一, 16 11月 2026 01:37:00 GMT` → `2026-11-16`。V8 认不出中文月份，自己拆。 */
export function bingDate(raw: string): string | undefined {
  const m = /(\d{1,2})\s+(\d{1,2})月\s+(\d{4})/.exec(raw);
  if (m) return `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
}

/** 必应的 `<item>` → 和博查同一个 `SearchHit` 形状，下游格式化和预算逻辑不用分叉。 */
export function parseBingRss(xml: string): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const item of xml.match(/<item>[\s\S]*?<\/item>/gi) ?? []) {
    const url = decodeXml(tagOf(item, "link"));
    if (!url) continue;
    const date = bingDate(decodeXml(tagOf(item, "pubDate")));
    let site: string | undefined;
    try {
      site = new URL(url).hostname;
    } catch {
      site = undefined;
    }
    hits.push({
      title: decodeXml(tagOf(item, "title")) || url,
      url,
      ...(site ? { site } : {}),
      ...(date ? { date } : {}),
      // description 里常夹 HTML 和实体，交给 htmlToText 一起收拾
      snippet: htmlToText(decodeXml(tagOf(item, "description"))),
    });
  }
  return hits;
}

/* ------------------------------------------------------------------- SSRF 防护 */

/** 内网 / 保留地址。**解析域名之后**也要用它查一遍。 */
export function isPrivateIp(ip: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // 云元数据 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // 运营商级 NAT
    return a >= 224; // 组播 / 保留
  }

  const v6 = ip.toLowerCase();
  if (v6 === "::1" || v6 === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(v6)) return true; // fc00::/7 唯一本地地址
  if (/^fe[89ab][0-9a-f]:/.test(v6)) return true; // fe80::/10 链路本地
  const mapped = /^::ffff:(.+)$/.exec(v6);
  if (mapped) return isPrivateIp(mapped[1]!); // ::ffff:127.0.0.1
  return false;
}

/**
 * 这个 URL 能不能抓。返回拒绝理由；可以抓返回 undefined。
 *
 * 先查字面地址，再查 DNS 结果 —— 只查前者的话，`127.0.0.1.nip.io` 这种域名就绕过去了。
 */
export async function checkUrl(raw: string): Promise<string | undefined> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `URL 格式不对：${raw}`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `只支持 http / https，不支持 ${url.protocol}`;
  }

  const host = url.hostname.replace(/^\[|\]$/g, ""); // [::1] → ::1
  if (host === "localhost" || host.endsWith(".localhost")) return "拒绝访问本机地址";
  if (isPrivateIp(host)) return `拒绝访问内网地址（${host}）`;

  try {
    const records = await lookup(host, { all: true });
    for (const record of records) {
      if (isPrivateIp(record.address)) return `拒绝访问内网地址（${host} → ${record.address}）`;
    }
  } catch {
    return `域名解析失败（${host}）`;
  }
  return undefined;
}

/* --------------------------------------------------------------------- 读响应 */

async function readCapped(res: Response, cap: number): Promise<string> {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(Buffer.from(value));
    size += value.byteLength;
    if (size >= cap) {
      await reader.cancel();
      break;
    }
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

/* ----------------------------------------------------------------------- 工具 */

/** 必应没有时间过滤，所以 `freshness` 只在博查那边出现 —— 不暴露模型做不到的参数。 */
function searchSchema(withFreshness: boolean) {
  return obj({
    query: str({ description: "Search keywords. Chinese works well." }),
    count: opt(num({ description: `How many results, default ${DEFAULT_COUNT}, max ${MAX_COUNT}.` })),
    ...(withFreshness
      ? {
          freshness: opt(
            union([lit("noLimit"), lit("oneDay"), lit("oneWeek"), lit("oneMonth"), lit("oneYear")], {
              description: "Time filter. Default noLimit.",
            }),
          ),
        }
      : {}),
  });
}

const fetchSchema = obj({
  url: str({ description: "Absolute http/https URL to read." }),
});

const SEARCH_DESCRIPTION =
  "Search the web. Returns titles, URLs and short summaries — not full pages. " +
  "Use it whenever the answer depends on current or factual information you are not sure about " +
  "(news, prices, releases, versions, people, docs). Do not answer from memory first. " +
  "After searching, call web_fetch on the 1-3 most promising URLs to read the actual content.";

function bochaSearchTool(options: WebOptions & { apiKey: string }) {
  const search = options.fetchImpl ?? fetch;
  return defineTool({
    name: "web_search",
    description: SEARCH_DESCRIPTION,
    parameters: searchSchema(true),
    async execute(args) {
      const query = args.query.trim();
      if (!query) return { output: [{ type: "text", text: "query 不能为空。" }], isError: true };

      const count = Math.min(Math.max(Math.trunc(args.count ?? DEFAULT_COUNT), 1), MAX_COUNT);

      let res: Response;
      try {
        res = await search(SEARCH_ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            query,
            count,
            summary: true,
            freshness: args.freshness ?? "noLimit",
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        return { output: [{ type: "text", text: `搜索请求失败：${messageOf(error)}` }], isError: true };
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return {
          output: [{ type: "text", text: `搜索接口返回 HTTP ${res.status}：${truncate(body, 300)}` }],
          isError: true,
        };
      }

      let json: unknown;
      try {
        json = await res.json();
      } catch (error) {
        return { output: [{ type: "text", text: `搜索接口返回的不是 JSON：${messageOf(error)}` }], isError: true };
      }

      const code = asNumber(asRecord(json)?.code);
      if (code !== undefined && code !== 200) {
        const msg = asString(asRecord(json)?.msg) ?? "未知错误";
        return { output: [{ type: "text", text: `搜索接口报错（code ${code}）：${msg}` }], isError: true };
      }

      return { output: [{ type: "text", text: formatHits(query, parseSearchHits(json)) }] };
    },
  });
}

function bingSearchTool(fetchImpl: typeof fetch = fetch) {
  return defineTool({
    name: "web_search",
    description: SEARCH_DESCRIPTION,
    parameters: searchSchema(false),
    async execute(args) {
      const fail = (text: string) => ({ output: [{ type: "text" as const, text }], isError: true });
      const query = args.query.trim();
      if (!query) return fail("query 不能为空。");

      const count = Math.min(Math.max(Math.trunc(args.count ?? DEFAULT_COUNT), 1), BING_COUNT);
      const url = `${BING_ENDPOINT}?q=${encodeURIComponent(query)}&format=rss`;

      let res: Response;
      try {
        res = await fetchImpl(url, {
          headers: { "User-Agent": UA, Accept: "application/rss+xml,application/xml;q=0.9,*/*;q=0.5" },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        return fail(`搜索请求失败：${messageOf(error)}`);
      }
      if (!res.ok) return fail(`必应搜索返回 HTTP ${res.status}`);

      const hits = parseBingRss(await res.text()).slice(0, count);
      return { output: [{ type: "text" as const, text: formatHits(query, hits) }] };
    },
  });
}

/** 有 key 走博查，没 key 走必应。调用方不用关心是哪一家。 */
export function webSearchTool(options: WebOptions = {}) {
  if (options.apiKey) {
    return bochaSearchTool(
      options.fetchImpl ? { apiKey: options.apiKey, fetchImpl: options.fetchImpl } : { apiKey: options.apiKey },
    );
  }
  return bingSearchTool(options.fetchImpl);
}

export function webFetchTool(fetchImpl: typeof fetch = fetch) {
  return defineTool({
    name: "web_fetch",
    description:
      "Fetch one web page and return its readable text (HTML stripped, truncated). " +
      "Use it after web_search picks a URL. Only public http/https addresses — " +
      "localhost, private networks and cloud metadata endpoints are blocked.",
    parameters: fetchSchema,
    async execute(args) {
      const started = args.url.trim();
      const failed = (text: string) => ({ output: [{ type: "text" as const, text }], isError: true });

      let target = started;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const blocked = await checkUrl(target);
        if (blocked) return failed(blocked);

        let res: Response;
        try {
          res = await fetchImpl(target, {
            redirect: "manual",
            headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" },
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
        } catch (error) {
          return failed(`抓取失败：${messageOf(error)}`);
        }

        // 手动跟重定向：每一跳都要重新过 checkUrl，否则公网域名可以 302 到内网
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location");
          if (!location) return failed(`HTTP ${res.status} 重定向但没有 Location`);
          try {
            target = new URL(location, target).toString();
          } catch {
            return failed(`重定向地址不合法：${location}`);
          }
          continue;
        }

        if (!res.ok) return failed(`HTTP ${res.status}`);

        const type = res.headers.get("content-type") ?? "";
        if (!/text\/|application\/(xhtml\+xml|json)/i.test(type)) {
          return failed(`不是文本页面（${type || "未知类型"}），读不了`);
        }

        const body = await readCapped(res, MAX_BODY_BYTES);
        const text = /html|xml/i.test(type) ? htmlToText(body) : body.trim();
        if (!text) return failed("页面没有可读文本（可能需要 JS 渲染）");
        return {
          output: [{ type: "text" as const, text: `来源：${target}\n\n${truncate(text, MAX_FETCH_CHARS)}` }],
        };
      }

      return failed(`重定向超过 ${MAX_REDIRECTS} 次`);
    },
  });
}

export function webExtension(options: WebOptions = {}) {
  return defineExtension({
    name: "pii-web",
    tools: [webSearchTool(options), webFetchTool(options.fetchImpl ?? fetch)],
  });
}
