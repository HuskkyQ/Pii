/**
 * 全部 `PII_*` 环境变量的**唯一读取点**。
 *
 * 为什么单独一个文件：以前这些读取散在 9 个文件里（`agent.ts`、`context.ts`、
 * `main.ts`、`push.ts`、`awake.ts`、`auth.ts`、`policies.ts`、`approvals.ts`、
 * `stage0.ts`），想知道「这个服务有哪些开关」得 grep 半个仓库。
 *
 * 三条纪律：
 *
 *  1. **每次调用都现场读 `process.env`，不做模块级缓存。**
 *     因为原有语义就是「调用时取值」：`defaultPolicy()` 在打启动日志时才读一次，
 *     `createAuth()` / `keepAwake()` 也在调用时才读。缓存成单例会让测试里改 env 失效。
 *
 *  2. **默认值必须与搬走前逐字一致。** 特别是这些「只有某个字符串才翻转」的判断：
 *     `PII_TOOLS !== "0"`、`PII_PUSH !== "0"`、`PII_IMAGE_REF !== "0"`、
 *     `PII_KEEP_AWAKE !== "0"`、`PII_COMPACT_OFF === "1"`、`PII_IMAGE_REF_QUIET === "1"`。
 *     写成布尔宽松解析（比如把 "false" 当假）就是行为变化。
 *
 *  3. **这里只读、不写。** 副作用留在各自模块：
 *     `auth-token` 文件由 `auth.ts` 的 `createAuth()` 创建，本文件绝不碰磁盘。
 *
 * 不归这里管的两个：
 *  - `PII_SERVER`（`web/vite.config.ts`）—— 前端开发代理，和服务端进程无关。
 *  - `PI_CODING_AGENT_DIR`（`src/provider.ts`）—— 前缀是 `PI_`，属于 pi 自己的模型目录。
 */
import { homedir } from "node:os";
import { join } from "node:path";

export interface PiiConfig {
  port: number;
  host: string;
  /** 未解析的原始值：`resolveDataDir` 还要能区分「没设」和「设成空串」。 */
  dataDirEnv: string | undefined;
  cwdEnv: string | undefined;
  provider: string;
  modelId: string;
  toolsEnabled: boolean;
  archiveDirEnv: string | undefined;
  imageRef: boolean;
  imageRefQuiet: boolean;
  /** 未设就是 undefined（不要 `Number(undefined)` → NaN 写进 compaction settings）。 */
  compactReserve: number | undefined;
  compactKeep: number | undefined;
  compactOff: boolean;
  thinkingLevel: string | undefined;
  snapshotTurns: number;
  viewEntries: number;
  /** 注意：`policies.ts` 和 `approvals.ts` 对 undefined 的解释**不同**，别合并默认值。 */
  autoAllowEnv: string | undefined;
  /** 一次工具审批最多挂多久；默认 120 秒，超时按拒绝处理（fail-closed）。 */
  approvalTimeoutMs: number;
  pushEnabled: boolean;
  vapidSubject: string;
  /** 「要求开鉴权」；实际是否启用还要看 `tokenEnv`，组合逻辑留在 `auth.ts`。 */
  authRequested: boolean;
  tokenEnv: string | undefined;
  user: string;
  passHash: string;
  tokenHintEnv: string;
  keepAwake: boolean;
  /** SIGINT/SIGTERM 后最多等多久让正在跑的会话结束；0 = 立刻退。 */
  shutdownIdleMs: number;
  /** 停止接受新连接后，给已有连接（含长连 SSE）收尾的窗口，超时硬断。 */
  shutdownGraceMs: number;
}

export function loadConfig(): PiiConfig {
  // 单独两个变量：只有「设了」才转数字，空串/未设都保持 undefined
  const compactReserveRaw = process.env.PII_COMPACT_RESERVE;
  const compactKeepRaw = process.env.PII_COMPACT_KEEP;
  return {
    port: Number(process.env.PII_PORT ?? 8787),
    host: process.env.PII_HOST ?? "127.0.0.1",
    dataDirEnv: process.env.PII_DATA_DIR,
    cwdEnv: process.env.PII_CWD,
    provider: process.env.PII_PROVIDER ?? "magpie",
    modelId: process.env.PII_MODEL ?? "workbuddy/deepseek-v4.1-flash",
    toolsEnabled: process.env.PII_TOOLS !== "0",
    archiveDirEnv: process.env.PII_ARCHIVE_DIR,
    imageRef: process.env.PII_IMAGE_REF !== "0",
    imageRefQuiet: process.env.PII_IMAGE_REF_QUIET === "1",
    compactReserve: compactReserveRaw ? Number(compactReserveRaw) : undefined,
    compactKeep: compactKeepRaw ? Number(compactKeepRaw) : undefined,
    compactOff: process.env.PII_COMPACT_OFF === "1",
    thinkingLevel: process.env.PII_THINKING,
    snapshotTurns: Number(process.env.PII_SNAPSHOT_TURNS ?? 5),
    viewEntries: Number(process.env.PII_VIEW_ENTRIES ?? 2000),
    autoAllowEnv: process.env.PII_AUTO_ALLOW,
    approvalTimeoutMs: Number(process.env.PII_APPROVAL_TIMEOUT_MS ?? 120_000),
    pushEnabled: process.env.PII_PUSH !== "0",
    vapidSubject: process.env.PII_VAPID_SUBJECT ?? "mailto:pii@localhost",
    authRequested: process.env.PII_AUTH === "1",
    tokenEnv: process.env.PII_TOKEN,
    user: (process.env.PII_USER ?? "").trim(),
    passHash: (process.env.PII_PASS_HASH ?? "").trim(),
    tokenHintEnv: (process.env.PII_TOKEN_HINT ?? "").trim(),
    keepAwake: process.env.PII_KEEP_AWAKE !== "0",
    // 这两个和编排的 stop_grace_period 是一套账：idle + grace 必须小于它，
    // 否则 docker 会在我们还在收尾时直接 SIGKILL。见 deploy/docker-compose.server.yml。
    shutdownIdleMs: Number(process.env.PII_SHUTDOWN_IDLE_MS ?? 10_000),
    shutdownGraceMs: Number(process.env.PII_SHUTDOWN_GRACE_MS ?? 3_000),
  };
}

/** 数据目录：`PII_DATA_DIR` → 默认 `~/.pii`。传了 override 就完全以它为准。 */
export function resolveDataDir(override?: string): string {
  return override ?? loadConfig().dataDirEnv ?? join(homedir(), ".pii");
}

/** agent 干活的工作目录（bash/read/write 的根）：`PII_CWD` → 默认启动目录。 */
export function resolveCwd(override?: string): string {
  return override ?? loadConfig().cwdEnv ?? process.cwd();
}

/** 归档目录：override → `PII_ARCHIVE_DIR` → `<数据目录>/archive`。 */
export function resolveArchiveDir(dataDir: string, override?: string): string {
  return override ?? loadConfig().archiveDirEnv ?? join(dataDir, "archive");
}
