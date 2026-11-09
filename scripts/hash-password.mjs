#!/usr/bin/env node
/**
 * 生成账号密码登录用的 scrypt 哈希（配合 PII_USER / PII_PASS_HASH）。
 *
 * 用法：
 *   npm run hash-pass                 # 交互输入用户名 + 密码两遍
 *   npm run hash-pass -- huskky       # 用户名走参数
 *
 * 输出形如：
 *   PII_USER=huskky
 *   PII_PASS_HASH=scrypt$<saltBase64>$<hashBase64>
 *
 * 设计取舍：
 *   - 只输出**哈希**，密码绝不上屏、不落盘、不进 shell history（交互输入、不回显）
 *   - 用 node:crypto 的 scrypt，不引 bcrypt 依赖（少一个要重新构建镜像的理由）
 *   - 参数固定 N=16384, r=8, p=1，和 src/server/auth.ts 的校验端一致
 *   - 盐每次随机 16 字节：同一个密码两次生成的结果不同，属正常现象
 *
 * 为什么要自己撸按键循环而不是用 readline：
 *   1) readline 没有「不回显」模式，只能靠覆写 _writeToOutput 这种内部 API 骗过去
 *   2) 「一个问题一个 readline 接口」在管道输入下会因第一次 close() 结束 stdin，
 *      第二个问题永远不 resolve（实测报 unsettled top-level await）
 *   3) 「pause → 下一问 resume」会丢掉粘贴的第二行（密码管理器一次填两行时就中招）
 *
 *   所以这里只保留一个常驻的 data 监听：收到的按键先进 queue，当前有提问就立刻
 *   喂给提问，没有就攒着。这样无论用户是一个字一个字敲，还是一次粘贴两行，
 *   都不会丢数据。
 */
import { randomBytes, scryptSync } from "node:crypto";

/** 非终端场景（管道输入、CI）：一次性读完 stdin，按行消费 */
let pipedLines = null;
if (!process.stdin.isTTY) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  pipedLines = Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
}
let pipedCursor = 0;

// ── 终端模式：常驻按键队列 ────────────────────────────────────────────────
/** 已经收到、但还没有提问在等它的按键 */
const queue = [];
/** 当前正在等待输入的提问（没有提问时为 null） */
let waiting = null;
let stdinStarted = false;

/** 把收到的按键交给当前提问；没有提问就先攒着 */
function feed(ch) {
  if (waiting) waiting.push(ch);
  else queue.push(ch);
}

function startStdin() {
  if (stdinStarted) return;
  const stdin = process.stdin;
  stdin.setRawMode(true); // 逐键读取，不走行缓冲（否则密码会先被终端显示出来）
  stdin.setEncoding("utf8");
  stdin.resume();
  stdin.on("data", (chunk) => {
    for (const ch of chunk) feed(ch);
  });
  stdinStarted = true;
  // 任何退出路径都要把终端还原，否则用户终端会卡在 raw 模式（不能回车）
  const restore = () => {
    try {
      stdin.setRawMode(false);
    } catch {
      /* 已经关了就算了 */
    }
  };
  process.on("exit", restore);
  process.on("SIGINT", () => {
    restore();
    process.stdout.write("\n");
    process.exit(130);
  });
}

/**
 * 问一个问题，返回用户输入的一行。
 * silent=true 时不回显输入的字符（密码），退格照常可用。
 */
function ask(question, { silent = false } = {}) {
  if (pipedLines) {
    process.stdout.write(`${question}\n`);
    return Promise.resolve(pipedLines[pipedCursor++] ?? "");
  }

  startStdin();
  return new Promise((resolve) => {
    process.stdout.write(question);
    let buf = "";

    waiting = {
      push(ch) {
        if (ch === "\u0003") {
          // Ctrl+C
          process.stdout.write("\n");
          process.exit(130);
        }
        // 结束符必须**最先**判断：\r 和 \n 的编码（0x0D / 0x0A）比空格还小，
        // 先跑「控制字符过滤」会把回车静默吃掉，然后永远等不到输入。
        if (ch === "\r" || ch === "\n") {
          waiting = null;
          process.stdout.write("\n");
          resolve(buf);
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          buf = buf.slice(0, -1);
          return;
        }
        // 其余控制字符（EOT / Ctrl+Z 等）不进密码：管道或 pty 偶尔会夹带一个
        if (ch < " " && ch !== "\t") return;
        buf += ch;
        if (!silent) process.stdout.write(ch); // 不回显时一个字符都不写
      },
    };

    // 队列里可能已经攒着上一问粘贴进来的后续行
    while (waiting && queue.length > 0) waiting.push(queue.shift());
  });
}

function hash(plain) {
  const salt = randomBytes(16);
  const derived = scryptSync(plain, salt, 32); // 默认 N=16384, r=8, p=1
  return `scrypt$${salt.toString("base64")}$${derived.toString("base64")}`;
}

const argUser = process.argv[2]?.trim();
const user = argUser || (await ask("用户名: ")).trim();

if (!/^[A-Za-z0-9._@-]{1,64}$/.test(user)) {
  console.error("用户名只能是 1-64 位字母、数字或 . _ @ -");
  process.exit(1);
}

const pass1 = await ask("密码（输入时不回显）: ", { silent: true });
const pass2 = await ask("再输一次: ", { silent: true });

if (pass1.length < 12) {
  console.error(`密码太短（现在 ${pass1.length} 位）。这个入口等价服务器 root，建议 ≥ 20 位随机串。`);
  process.exit(1);
}
if (pass1 !== pass2) {
  console.error("两次输入不一致");
  process.exit(1);
}

console.log("\n把下面两行写进服务器上的 /opt/pii-test/secrets/pii.env（权限 600）：\n");
console.log(`PII_USER=${user}`);
// `$` 成对：Docker Compose 会插值 env_file 里的 `$`，单个 `$` 后面的字符
// 会被当成变量名（未定义就删空），哈希就被默默改写了。
// 写进文件时用 `$$`，Compose 读完后容器里看到的是单个 `$`，应用照常解析。
console.log(`PII_PASS_HASH=${hash(pass1).replaceAll("$", "$$")}`);
console.log("\n↑ 哈希里的 $$ 是给 Docker Compose 的转义，直接整行粘贴即可。");
console.log("  （哈希本身可以公开：它不能反推出密码。但请把原始密码存进密码管理器。）");
