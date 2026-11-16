/**
 * 联网搜索的解析、SSRF 防护和工具行为测试。
 *
 * 不打真实网络：搜索用假的 fetch，抓取只走「被拦下」或「公网 IP 字面量」两条路
 * —— 后者 `dns.lookup` 不会真的发请求，测试可以离线跑。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createRegistry } from "@earendil-works/pi-durable";

import {
  bingDate,
  checkUrl,
  decodeXml,
  formatHits,
  htmlToText,
  isPrivateIp,
  parseBingRss,
  parseSearchHits,
  webExtension,
  webFetchTool,
  webSearchTool,
} from "../src/tools/web.ts";

/** 博查真实返回的骨架。 */
function bochaBody(items: unknown[]) {
  return { code: 200, log_id: "x", msg: null, data: { webPages: { value: items } } };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function textOf(result: { output: unknown }): string {
  return String((result.output as { text: string }[])[0]!.text);
}

/* ------------------------------------------------------------------ 解析 */

test("解析：博查的 data.webPages.value 取出标题/链接/站点/摘要", () => {
  const hits = parseSearchHits(
    bochaBody([
      {
        name: "标题一",
        url: "https://a.example/1",
        siteName: "站点一",
        datePublished: "2026-11-01",
        snippet: "短摘要",
        summary: "长摘要",
      },
      { url: "https://b.example/2" }, // 没有标题 → 退回用 url
      { name: "没链接" }, // 没 url → 丢掉
    ]),
  );

  assert.equal(hits.length, 2);
  assert.deepEqual(hits[0], {
    title: "标题一",
    url: "https://a.example/1",
    site: "站点一",
    date: "2026-11-01",
    snippet: "长摘要", // summary 优先于 snippet
  });
  assert.equal(hits[1]!.title, "https://b.example/2");
  assert.equal(hits[1]!.site, undefined);
});

test("解析：结构不对时返回空数组，不抛异常", () => {
  assert.deepEqual(parseSearchHits(null), []);
  assert.deepEqual(parseSearchHits({ code: 200 }), []);
  assert.deepEqual(parseSearchHits({ data: { webPages: { value: "不是数组" } } }), []);
});

test("格式化：编号、链接、来源都在，末尾提示去抓正文", () => {
  const text = formatHits("测试", [{ title: "T", url: "https://a.example/1", site: "S", snippet: "摘要" }]);
  assert.match(text, /搜索「测试」共 1 条/);
  assert.match(text, /\[1\] T\nhttps:\/\/a\.example\/1\nS\n摘要/);
  assert.match(text, /web_fetch/);
});

test("格式化：空结果给出换关键词的提示", () => {
  assert.match(formatHits("测试", []), /没有搜到结果/);
});

test("格式化：总长度受预算限制，不会把 15 条全塞进去", () => {
  const long = Array.from({ length: 15 }, (_, i) => ({
    title: `标题${i}`,
    url: `https://x.example/${i}`,
    snippet: "很长的摘要".repeat(200),
  }));
  const text = formatHits("q", long);
  assert.ok(text.length < 8000, `实际 ${text.length} 字`);
  assert.doesNotMatch(text, /\[15\]/); // 后面几条被预算截掉了
});

/* ------------------------------------------------------------------ HTML */

test("HTML：剥掉 script/style 和标签，解实体", () => {
  const html = `
    <html><head><style>.a{color:red}</style><script>var x = "<p>别要"</script></head>
    <body><h1>标题</h1><p>第一段 &amp; 第二段</p><p>a &lt; b</p><div>尾</div></body></html>`;
  const text = htmlToText(html);
  assert.doesNotMatch(text, /color:red|var x/);
  assert.match(text, /标题/);
  assert.match(text, /第一段 & 第二段/);
  assert.match(text, /a < b/);
});

test("HTML：&amp;lt; 还原成 &lt; 而不是 <", () => {
  assert.match(htmlToText("<p>&amp;lt;tag&amp;gt;</p>"), /&lt;tag&gt;/);
});

/* --------------------------------------------------------------- SSRF */

test("内网判断：常见私网、元数据、回环、ULA 都算内网", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // 云元数据
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
});

test("内网判断：公网地址放行", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "140.82.113.35", "172.32.0.1", "2400:3200::1"]) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test("URL 检查：协议、localhost、字面内网地址都被拒", async () => {
  assert.match(String(await checkUrl("file:///etc/passwd")), /只支持 http/);
  assert.match(String(await checkUrl("http://localhost:8443/api/ops")), /本机/);
  assert.match(String(await checkUrl("http://127.0.0.1:8443/api/ops")), /内网/);
  assert.match(String(await checkUrl("http://169.254.169.254/latest/meta-data/")), /内网/);
  assert.match(String(await checkUrl("http://[::1]/")), /内网/);
  assert.match(String(await checkUrl("不是网址")), /格式不对/);
});

test("URL 检查：IP 字面量的公网地址通过（不触发真实 DNS 查询）", async () => {
  assert.equal(await checkUrl("https://1.1.1.1/page"), undefined);
});

/* ------------------------------------------------------------------ 工具 */

test("web_search：拼对请求体，输出带编号的结果", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const fake = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return jsonResponse(
      bochaBody([{ name: "结果一", url: "https://a.example/1", snippet: "摘要一", siteName: "站点" }]),
    );
  }) as unknown as typeof fetch;

  const tool = webSearchTool({ apiKey: "k-123", fetchImpl: fake });
  const result = (await tool.execute({ query: "pii 备份" } as never, {} as never, {} as never)) as {
    output: unknown;
    isError?: boolean;
  };

  assert.equal(seen!.url, "https://api.bochaai.com/v1/web-search");
  const headers = seen!.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer k-123");
  const body = JSON.parse(String(seen!.init.body)) as { query: string; count: number; summary: boolean };
  assert.equal(body.query, "pii 备份");
  assert.equal(body.count, 8);
  assert.equal(body.summary, true);

  assert.match(textOf(result), /结果一/);
  assert.equal(result.isError, undefined);
});

test("web_search：count 超出上限被夹到 15", async () => {
  let body: { count: number } | undefined;
  const fake = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body)) as { count: number };
    return jsonResponse(bochaBody([]));
  }) as unknown as typeof fetch;

  await webSearchTool({ apiKey: "k", fetchImpl: fake }).execute({ query: "q", count: 999 } as never, {} as never, {} as never);
  assert.equal(body!.count, 15);
});

test("web_search：接口 code 非 200 时报错而不是装没事", async () => {
  const fake = (async () => jsonResponse({ code: 403, msg: "余额不足" })) as unknown as typeof fetch;
  const result = (await webSearchTool({ apiKey: "k", fetchImpl: fake }).execute(
    { query: "q" } as never,
    {} as never,
    {} as never,
  )) as { output: unknown; isError?: boolean };

  assert.equal(result.isError, true);
  assert.match(textOf(result), /余额不足/);
});

test("web_search：HTTP 非 2xx 时报错", async () => {
  const fake = (async () => new Response("too many requests", { status: 429 })) as unknown as typeof fetch;
  const result = (await webSearchTool({ apiKey: "k", fetchImpl: fake }).execute(
    { query: "q" } as never,
    {} as never,
    {} as never,
  )) as { isError?: boolean };

  assert.equal(result.isError, true);
});

/** 重定向到内网：必须拦在第二跳。 */
test("web_fetch：302 跳到内网地址被拦下", async () => {
  const fake = (async () =>
    new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8443/api/ops" } })) as unknown as typeof fetch;

  const result = (await webFetchTool(fake).execute({ url: "https://1.1.1.1/start" } as never, {} as never, {} as never)) as {
    output: unknown;
    isError?: boolean;
  };

  assert.equal(result.isError, true);
  assert.match(textOf(result), /内网/);
});

test("web_fetch：正常页面剥标签后带来源返回", async () => {
  const fake = (async () =>
    new Response("<html><body><h1>Hello</h1><script>x()</script><p>正文</p></body></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    })) as unknown as typeof fetch;

  const result = (await webFetchTool(fake).execute({ url: "https://1.1.1.1/a" } as never, {} as never, {} as never)) as {
    output: unknown;
  };
  const text = textOf(result);
  assert.match(text, /来源：https:\/\/1\.1\.1\.1\/a/);
  assert.match(text, /Hello/);
  assert.match(text, /正文/);
  assert.doesNotMatch(text, /x\(\)/);
});

test("web_fetch：非文本类型直接拒绝", async () => {
  const fake = (async () =>
    new Response("%PDF-1.4", { status: 200, headers: { "content-type": "application/pdf" } })) as unknown as typeof fetch;

  const result = (await webFetchTool(fake).execute({ url: "https://1.1.1.1/a.pdf" } as never, {} as never, {} as never)) as {
    isError?: boolean;
  };
  assert.equal(result.isError, true);
});

test("扩展：装上后注册了 web_search 和 web_fetch", () => {
  for (const options of [{ apiKey: "k" }, {}]) {
    const registry = createRegistry();
    registry.install(webExtension(options));
    const names = registry.snapshot().tools().map(({ tool }) => tool.name);
    assert.ok(names.includes("web_search"), names.join(","));
    assert.ok(names.includes("web_fetch"), names.join(","));
  }
});

/* ------------------------------------------------------------- 必应 RSS */

const RSS = `<rss version="2.0"><channel><title>必应：博查</title>
<item>
  <title>博查AI开放平台 | Search API</title>
  <link>https://open.bochaai.com/</link>
  <description>博查提供&lt;b&gt;Web Search&lt;/b&gt; API&amp;nbsp;服务</description>
  <pubDate>周一, 16 11月 2026 01:37:00 GMT</pubDate>
</item>
<item>
  <title><![CDATA[CDATA 标题]]></title>
  <link><![CDATA[https://b.example/2?a=1&b=2]]></link>
  <description><![CDATA[<p>正文 &amp; 更多</p>]]></description>
</item>
</channel></rss>`;

test("必应 RSS：解出标题/链接/站点/日期/摘要", () => {
  const hits = parseBingRss(RSS);
  assert.equal(hits.length, 2);

  assert.equal(hits[0]!.title, "博查AI开放平台 | Search API");
  assert.equal(hits[0]!.url, "https://open.bochaai.com/");
  assert.equal(hits[0]!.site, "open.bochaai.com");
  assert.equal(hits[0]!.date, "2026-11-16"); // 中文月份自己拆
  assert.equal(hits[0]!.snippet, "博查提供 Web Search API 服务"); // 标签和实体都清掉

  assert.equal(hits[1]!.title, "CDATA 标题");
  assert.equal(hits[1]!.url, "https://b.example/2?a=1&b=2");
  assert.equal(hits[1]!.snippet, "正文 & 更多");
  assert.equal(hits[1]!.date, undefined);
});

test("必应 RSS：空响应 / 结构不对时返回空数组", () => {
  assert.deepEqual(parseBingRss(""), []);
  assert.deepEqual(parseBingRss("<html>被拦了</html>"), []);
});

test("XML 实体：&amp;lt; 还原成 &lt; 而不是 <", () => {
  assert.equal(decodeXml("&amp;lt;tag&amp;gt;"), "&lt;tag&gt;");
  assert.equal(decodeXml("&#39;"), "'");
  assert.equal(decodeXml("&#x4e2d;"), "中");
});

test("bingDate：中文格式转 ISO，认不出来的丢掉", () => {
  assert.equal(bingDate("周一, 16 11月 2026 01:37:00 GMT"), "2026-11-16");
  assert.equal(bingDate(""), undefined);
  assert.equal(bingDate("不是日期"), undefined);
});

test("web_search 无 key：走必应 RSS，带 format=rss", async () => {
  let requested = "";
  const fake = (async (url: string) => {
    requested = url;
    return new Response(RSS, { status: 200, headers: { "content-type": "application/xml" } });
  }) as unknown as typeof fetch;

  const result = (await webSearchTool({ fetchImpl: fake }).execute({ query: "博查 搜索" } as never, {} as never, {} as never)) as {
    output: unknown;
  };

  assert.match(requested, /^https:\/\/cn\.bing\.com\/search\?q=/);
  assert.match(requested, /format=rss/);
  assert.match(decodeURIComponent(requested), /q=博查 搜索/);
  assert.match(textOf(result), /博查AI开放平台/);
});

test("web_search 无 key：count 生效（必应给 10 条，只要 1 条就切 1 条）", async () => {
  const fake = (async () =>
    new Response(RSS, { status: 200, headers: { "content-type": "application/xml" } })) as unknown as typeof fetch;

  const result = (await webSearchTool({ fetchImpl: fake }).execute(
    { query: "q", count: 1 } as never,
    {} as never,
    {} as never,
  )) as { output: unknown };
  const text = textOf(result);
  assert.match(text, /\[1\]/);
  assert.doesNotMatch(text, /\[2\]/);
});

test("web_search 无 key：必应返回非 200 时报错", async () => {
  const fake = (async () => new Response("blocked", { status: 403 })) as unknown as typeof fetch;
  const result = (await webSearchTool({ fetchImpl: fake }).execute(
    { query: "q" } as never,
    {} as never,
    {} as never,
  )) as { isError?: boolean };
  assert.equal(result.isError, true);
});
