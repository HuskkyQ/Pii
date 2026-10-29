/**
 * 用 CDP 给 pii 的页面截图，并抓控制台错误。
 * 不依赖 puppeteer：Node 22 自带 WebSocket。
 */
const PORT = Number(process.env.CDP_PORT ?? 9222);
const URL_TO_OPEN = process.argv[2] ?? "http://127.0.0.1:8787/";
const OUT = process.argv[3] ?? "/tmp/pii-ui.png";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("没有可用的 page target");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const logs = [];

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === "Runtime.consoleAPICalled") {
      const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
      logs.push(`[${msg.params.type}] ${text}`);
    }
    if (msg.method === "Runtime.exceptionThrown") {
      logs.push(`[exception] ${msg.params.exceptionDetails.text} ${msg.params.exceptionDetails.exception?.description ?? ""}`);
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
  await send("Page.enable");
  const width = Number(process.env.SHOT_W ?? 1200);
  const height = Number(process.env.SHOT_H ?? 880);
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: width < 600,
  });
  await send("Page.navigate", { url: URL_TO_OPEN });
  await sleep(3500);

  // 顺便取一下 DOM 文字，确认 React 真的渲染了
  const text = await send("Runtime.evaluate", {
    expression: "document.body.innerText.slice(0, 600)",
    returnByValue: true,
  });
  console.log("=== 页面文字 ===");
  console.log(text?.result?.value ?? "(空)");

  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  if (shot?.data) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(OUT, Buffer.from(shot.data, "base64"));
    console.log(`\n截图已保存 ${OUT}`);
  } else {
    console.log("\n截图失败");
  }

  console.log("\n=== 控制台 ===");
  console.log(logs.length ? logs.join("\n") : "(无输出)");
  ws.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
