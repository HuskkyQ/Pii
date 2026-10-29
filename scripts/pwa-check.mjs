/**
 * PWA 自检：用 CDP 打开页面，检查 manifest / service worker / 安装条件。
 * 不依赖 puppeteer：Node 22 自带 WebSocket。
 *
 * 用法：CDP_PORT=9223 node scripts/pwa-check.mjs http://127.0.0.1:8787/
 */
const PORT = Number(process.env.CDP_PORT ?? 9222);
const TARGET = process.argv[2] ?? "http://127.0.0.1:8787/";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("没有可用的 page target");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const problems = [];

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === "Runtime.exceptionThrown") {
      problems.push(`[exception] ${msg.params.exceptionDetails.text}`);
    }
    if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      problems.push(`[log] ${msg.params.entry.text}`);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const msgId = ++id;
      pending.set(msgId, resolve);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: TARGET });
  await sleep(3500);

  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result?.exceptionDetails) return { error: result.exceptionDetails.text };
    return result?.result?.value;
  };

  const report = await evaluate(`(async () => {
    const out = {};
    const link = document.querySelector('link[rel="manifest"]');
    out.manifestHref = link ? link.href : null;
    if (out.manifestHref) {
      try {
        const res = await fetch(out.manifestHref);
        out.manifestStatus = res.status;
        out.manifestType = res.headers.get('content-type');
        const json = await res.json();
        out.manifestName = json.name;
        out.manifestDisplay = json.display;
        out.iconCount = (json.icons ?? []).length;
        // 逐个检查图标真的存在
        out.iconsOk = [];
        for (const icon of json.icons ?? []) {
          const r = await fetch(icon.src);
          out.iconsOk.push(icon.src + ':' + r.status);
        }
      } catch (error) {
        out.manifestError = String(error);
      }
    }
    out.secureContext = window.isSecureContext;
    out.swSupported = 'serviceWorker' in navigator;
    if (out.swSupported) {
      const regs = await navigator.serviceWorker.getRegistrations();
      out.swRegistrations = regs.length;
      out.swScope = regs[0]?.scope ?? null;
      out.swState = regs[0]?.active?.state ?? regs[0]?.installing?.state ?? null;
    }
    out.appleTouchIcon = document.querySelector('link[rel="apple-touch-icon"]')?.href ?? null;
    out.themeColor = document.querySelector('meta[name="theme-color"]')?.content ?? null;
    out.title = document.title;
    return out;
  })()`);

  console.log(JSON.stringify(report, null, 2));
  console.log("\n问题：", problems.length ? problems.join("\n") : "(无)");
  ws.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
