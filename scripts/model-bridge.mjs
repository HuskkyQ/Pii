#!/usr/bin/env node
/**
 * 模型中转（model bridge）。
 *
 * 场景：pii 跑在云服务器上，但模型来自 Mac 上的 magpie（只监听 127.0.0.1:3425）。
 * 服务器没法直连 Mac 的回环地址，所以让 Mac 主动把这个端口「搬到」tailnet 上：
 *
 *   服务器  --(tailnet)-->  Mac:100.x.y.z:3425  --(本脚本)-->  127.0.0.1:3425 (magpie)
 *
 * 为什么用 TCP 透传而不是 HTTP 代理：
 *   magpie 走的是 OpenAI 兼容接口，回复是 SSE 流式。TCP 层原样转发最省事 ——
 *   不管什么方法、什么分块，一个字节都不动，流式天然就对。
 *
 * 安全：只监听 tailnet 地址（默认取 tailscale 的 100.x），公网看不到。
 *      想更严可以配合 tailnet ACL 限制只有那台服务器能访问。
 *
 * 用法：
 *   node scripts/model-bridge.mjs                     # 自动找 tailnet IPv4，监听 3425
 *   BRIDGE_LISTEN=0.0.0.0:3425 node scripts/model-bridge.mjs
 *   BRIDGE_TARGET=127.0.0.1:3425 node scripts/model-bridge.mjs
 */
import { createServer, connect } from "node:net";
import { execFileSync } from "node:child_process";

const TARGET = process.env.BRIDGE_TARGET ?? "127.0.0.1:3425";

/** 从 tailscale status 里取本机的 100.x 地址；取不到就退回 127.0.0.1。 */
function tailnetAddress() {
  try {
    const raw = execFileSync(
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      ["status", "--json"],
      { encoding: "utf8", timeout: 5000 },
    );
    const json = JSON.parse(raw);
    const ips = json.Self?.TailscaleIPs ?? [];
    const v4 = ips.find((ip) => ip.startsWith("100."));
    if (v4) return v4;
  } catch {
    /* 没装 tailscale / 没登录 */
  }
  return "127.0.0.1";
}

const listenSpec = process.env.BRIDGE_LISTEN ?? `${tailnetAddress()}:3425`;
const [listenHost, listenPort] = listenSpec.split(":");
const [targetHost, targetPort] = TARGET.split(":");

let connections = 0;
let bytesIn = 0;
let bytesOut = 0;

const server = createServer((client) => {
  connections += 1;
  const id = connections;
  const startedAt = Date.now();
  let closed = false;

  const upstream = connect({ host: targetHost, port: Number(targetPort) });
  upstream.setNoDelay(true);
  client.setNoDelay(true);

  const finish = (why) => {
    if (closed) return;
    closed = true;
    client.destroy();
    upstream.destroy();
    const ms = Date.now() - startedAt;
    console.log(`  #${id} 结束（${why}） 用时 ${ms}ms`);
  };

  client.on("data", (chunk) => {
    bytesIn += chunk.length;
    upstream.write(chunk);
  });
  upstream.on("data", (chunk) => {
    bytesOut += chunk.length;
    client.write(chunk);
  });

  client.on("error", () => finish("client error"));
  upstream.on("error", (error) => finish(`upstream: ${error.code ?? error.message}`));
  client.on("close", () => finish("client closed"));
  upstream.on("close", () => finish("upstream closed"));
});

server.on("error", (error) => {
  console.error(`监听 ${listenSpec} 失败：${error.message}`);
  if (error.code === "EADDRINUSE") {
    console.error("端口被占了 —— magpie 自己就在 3425 上。换个端口：BRIDGE_LISTEN=100.x.y.z:3426");
  }
  process.exit(1);
});

server.listen(Number(listenPort), listenHost, () => {
  console.log("模型中转已启动");
  console.log(`  监听    ${listenHost}:${listenPort}`);
  console.log(`  转发到  ${targetHost}:${targetPort}（magpie）`);
  console.log("");
  console.log("服务器上的 models.json 这样配：");
  console.log(`  "baseUrl": "http://${listenHost}:${listenPort}/v1"`);
});

process.on("SIGINT", () => {
  console.log(`\n收到 SIGINT，共 ${connections} 次连接，上行 ${(bytesIn / 1024).toFixed(0)}KB 下行 ${(bytesOut / 1024).toFixed(0)}KB`);
  server.close(() => process.exit(0));
});
