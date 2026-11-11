# 设计：`src/server/main.ts` 按职责域拆分

日期：2026-11-11
状态：已批准，实施完成（本地已验证，未上线）

## 1. 目标与边界

`src/server/main.ts` 现有 1292 行（全项目唯一超过 600 行的源码文件；第二名 `src/server/project.ts` 380 行）。其中 147 空行 + 263 注释行，占 32%。文件里同时装着 38 个路由注册、十几份全局状态、启动初始化、鉴权中间件、静态托管和优雅退出。

本次目标是**把隐式全局依赖变成显式依赖**：文件变小是结果，结构清晰是目的。

验收标准：

1. 所有手写源码文件（`.ts` / `.tsx` / `.mjs` / `.sh`）行数 < 600。
2. 外部行为完全不变：API 路径、请求体、响应格式、鉴权行为、SSE 行为、启动日志、健康检查路径，一字不改。

明确不做：

- 不改任何 API 路径、请求体、响应格式。
- 不改前端一行，不动数据库、`/data`、`models.json` 挂载。
- 不碰 `web/`、`scripts/`、`deploy/`、compose、Caddy。
- 不引入新依赖、不上路由框架、不改业务逻辑。
- 不做部署层的前端/服务端拆分（该方案已搁置）。

口径说明：`docs/ENGINEERING.md`（1102 行）是文档、`package-lock.json`（1903 行）是生成物，均不计入「代码行数」。

## 2. 目标结构

```
src/server/
├─ main.ts              ← 1292 → 60 行：启动、注册顺序、listen、优雅退出
├─ context.ts           ← 新增：AppContext 类型 + createContext()（原 1–274 的初始化/辅助函数）
├─ auth-routes.ts       ← 新增：登录页 / cookie / 限速 / 401 中间件（原 284–427）
├─ static.ts            ← 新增：/、/assets、/icons、sw.js、manifest、缓存头、兜底
└─ routes/
   ├─ files.ts          ← cwd / fs / import / compact / archive / image
   ├─ session.ts        ← state / conversations / policy / last-conversation
   ├─ run.ts            ← prompt / abort / stream(SSE) / approvals / approve
   └─ meta.ts           ← models / model / restart / build / push / client-metrics / auth
```

延续项目已有模式：`src/server/` 下原本就是一组小模块（`auth.ts`、`push.ts`、`policies.ts`、`conversations.ts`、`archive.ts` 等，均 < 270 行，导出 `class` / `function` / `interface`）。本次只是把散落在 `main.ts` 的路由也收进同一模式，不发明新范式。

## 3. 依赖传递：`AppContext`

路由区（原 498–1272 行）实际抓取的顶层变量共 20 个：`agent`(14)、`resolveConversation`(15)、`push`(10)、`watch`(8)、`approvals`(6)、`titles`(6)、`archiveDir`(5)、`customTitles`(4)、`trash`(4)、`lastConversation`(3)、`policies`(3)、`restartPending`(3)、`taskDuration`(2)、`isIdle`(2)、`dataDir`(2)、`startedAt`(2)、`WEB_DIST`(2)、`newestMtime`(1)、`latestFailure`(1)、`watching`(1)。

统一形状：

```ts
export interface AppContext { /* agent、auth、push、policies、审批、标题、回收站、锁、生命周期… */ }
export async function createContext(): Promise<AppContext>

// 每个路由模块统一签名
export function registerFiles(app: Hono, ctx: AppContext): void
```

`AppContext` 按批次演进：第 1 批只装启动初始化相关的字段，后续批次随路由迁出逐步加入 `archiveDir`、`clientMetrics`、`resolveConversation`、`isIdle`、`flags` 等。接口字段随实现扩展，不留占位符。

**可变状态的处理规则（实现约束）**：

- `restartPending`（原 `main.ts:849` 的 `let boolean`）是值类型。若写成 `const { restartPending } = ctx` 再赋值，改的是副本，`/api/restart` 的「已在等待」判断失效，可能触发重启环（原 `main.ts:839` 注释专门记录过该风险）。必须包成对象 `ctx.flags.restartPending`，或提供 get/set。
- `watching` / `titles` / `durationCache` / `clientMetrics` 是 `Map` / 数组，传引用即可，但不得重新赋值整个对象。
- `releaseLock` / `awake` 供 `main.ts` 的 `shutdown()` 使用，必须经 `ctx` 返回，不能留在被搬走的模块里当隐式全局。

## 4. 注册顺序（三条铁律）

Hono 按注册先后匹配。原 `main.ts:1273` 注释已警告：`app.use("*", serveStatic)` 必须放在所有 `/api` 路由之后，否则 `/api/*` 会被它先吃掉。拆成多文件后，顺序从「同一文件往下看」变成跨文件约定，因此由 `main.ts` 一处显式列出：

```ts
const app = new Hono();
const ctx = await createContext();

app.use(compress());                              // ① 必须最前（SSE 要跳过压缩）
if (ctx.auth.enabled) registerAuth(app, ctx);     // ② 必须在所有业务路由之前
registerMeta(app, ctx);                          // ③ 业务路由
registerFiles(app, ctx);
registerSession(app, ctx);
registerRun(app, ctx);
registerStatic(app, ctx);                        // ④ 页面与静态资源
app.use("*", serveStatic(...));                  // ⑤ 必须最后：兜底

serve({ fetch: app.fetch, ... });
```

铁律：

1. 静态兜底 `app.use("*", serveStatic)` 只能在 `main.ts` 注册。全局鉴权中间件是唯一例外：它随 `registerAuth` 一起注册，但位置由 `main.ts` 固定在所有业务路由之前（见下方顺序图）。各 routes 模块一律 `registerX(app, ctx)`，不得自行 `listen`、不得注册兜底。
2. `if (auth.enabled)` 为 false 时 `/login` / `/logout` 压根不注册（原 `main.ts:313`），行为必须保持一致。
3. `/api/auth`（返回 `{enabled, password}`）保持在鉴权中间件之后，不得挪位。

## 5. 迁移步骤（一批一搬，每批可验证、可回退）

| 批 | 动作 | 验证 |
|---|---|---|
| 1 | 新建 `context.ts`，把原 1–274 行的常量/锁/状态初始化/耗时与失败查询收进 `createContext()`；`main.ts` 改为 `const ctx = await createContext()` + 解构出原有裸变量名（路由暂不搬，零改动） | `npm run check` |
| 2 | 抽 `static.ts`（`/`、`/assets`、`/icons`、`sw.js`、`manifest`、缓存头）与末尾兜底；顺序最敏感，先做 | `/`、`/assets/*` 200；`/api/state` 未被静态吃掉 |
| 3 | 抽 `auth-routes.ts`（登录页、cookie、限速、401 中间件、`clientIp`） | 开/关 `PII_AUTH` 两种模式：`/login` 正常、未登录 `/api/*` 返回 401 JSON 而非登录页 HTML |
| 4 | 按域搬 `files` → `session` → `run` → `meta`，一次一个；共享定义（`resolveConversation`、`isIdle`、`archiveDir`、`clientMetrics`、`flags.restartPending`）随对应批次收进 `ctx` | 每搬一个跑一次类型检查 + 该组接口 curl |
| 5 | 收尾：清理 `main.ts` 多余 import，骨架只剩启动/注册顺序/退出 | 行数验收 + 全量回归 |

中间状态只在本地提交，不推线上；每批之间可单独 `git revert`。五批均已执行完毕，结果见第 9 节。

## 6. 验证清单

- `npm run check`（`tsc --noEmit` + 前端构建）。本次是纯搬迁，**类型检查是主力**：漏传依赖会直接编译报错。
- 本地 `npm start`，照 `docs/ENGINEERING.md:97–127` 的 API 表逐条过一遍（35 条，行为必须一致）。
- 重点四条：`/manifest.webmanifest` 返回 200（`Dockerfile:47` 的健康探针和三个部署脚本都打它）；SSE 能吐字；`/api/restart` 的 `flags.restartPending` 仍生效；开鉴权时 401 响应格式不变。
- 行数验收：`find src web/src scripts deploy -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.mjs' -o -name '*.sh' \) -exec wc -l {} +`，确认全部 < 600。
- 上线：本次改动属于 `src/**`，必须走 `deploy/self-update/pii-deploy.sh`（等会话空闲 → 冒烟 → 备份数据库 → 切换 → 失败回滚），不能用 `docker restart` 代替。

## 7. 风险与兜底

| 风险 | 兜底 |
|---|---|
| 循环依赖（`context.ts` ↔ routes） | 用 `import type` 断开，类型不产生运行时依赖 |
| 静态兜底提前注册吃掉 `/api/*` | 顺序只在 `main.ts` 一处列出，第 2 批先验证该行为 |
| 值类型共享状态被解构成副本 | 按第 3 节规则包成 `flags` 对象 |
| `verbatimModuleSyntax: true` 下类型导入写法 | 一律 `import type` 或 inline `type` 修饰符 |
| 线上入口改动打断正在跑的 agent | 分批本地验证；上线走自更新脚本的四道安全线 |

## 8. 实现计划

按第 5 节表格顺序执行，每批结束后运行 `npm run check`，通过后才进入下一批。第 5 批完成后运行第 6 节全量验证清单。不额外另写计划文档：本文件第 5、6 节即实施计划与验收标准。

## 9. 实施记录

### 最终结构（全部 < 600 行）

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/server/main.ts` | 60 | 启动、注册顺序、静态兜底、listen、信号处理 |
| `src/server/context.ts` | 409 | `AppContext` + `createContext()` + 共享常量/函数 |
| `src/server/auth-routes.ts` | 166 | 登录、cookie、限速、401 中间件、`/api/auth` |
| `src/server/static.ts` | 60 | `/`、`/assets`、`/icons`、`sw.js`、`manifest`、缓存头 |
| `src/server/routes/files.ts` | 282 | cwd / fs / import / compact / archive / image |
| `src/server/routes/meta.ts` | 217 | models / 删除会话 / restart / build / push / client-metrics |
| `src/server/routes/run.ts` | 188 | prompt / abort / SSE / approvals |
| `src/server/routes/session.ts` | 132 | state / conversations / policy / last / patch |

全仓手写源码最大文件为 `context.ts`（409 行），第二名 `project.ts`（380 行），无任何文件超过 600 行。

### 相对原设计的三处微调

1. **`attachServer` / `shutdown` 进 `ctx`**：`/api/restart` 原本调用 `main.ts` 的局部 `shutdown()`，路由搬走后拿不到。现在 `ctx.shutdown(reason)` 统一供 `/api/restart` 与 `SIGINT`/`SIGTERM` 使用；HTTP server 由 `main.ts` 在 `listen` 之后经 `ctx.attachServer(server)` 交进来，避免 ctx 创建时反向依赖。
2. **`serverDir` 进 `ctx`**：`/api/build` 原来用 `dirname(fileURLToPath(import.meta.url))` 扫源码 mtime。代码搬到 `routes/` 后该路径会变成 `src/server/routes/`，扫描范围变窄、`behind` 判断失真。改用 `ctx.serverDir`（`context.ts` 所在目录，与原 `main.ts` 同目录），行为保持一致。
3. **`windowOptions` 进 `ctx`**：它依赖 `taskDuration`，且被 `session` 与 `run` 两个模块共用。在 `context.ts` 模块级定义纯函数（注入 `durationOf`），`ctx.windowOptions` 绑定 `taskDuration` 后暴露，调用点一行未改。

`/api/restart` 的 `let restartPending` 已按第 3 节规则改成 `ctx.flags.restartPending`（对象字段，非解构副本），`routes/meta.ts` 中三处引用均已验证。

### 验证结果

- `npm run check`（`tsc --noEmit` + `vite build`）：通过。
- 本地临时实例（`PII_DATA_DIR=/tmp/pii-refactor-check PII_PORT=18787 PII_AUTH=1`）冒烟：
  - `/manifest.webmanifest` 200（健康探针路径）
  - `/favicon.svg` 200（静态兜底生效）
  - 未登录 `/` 返回 401 HTML 登录页；未登录 `/api/state` 返回 **401 JSON**（证明 `/api/*` 未被静态兜底吃掉、鉴权中间件位置正确）
  - 登录后 `/api/auth`、`/api/build`（assets 35 项、`swVersion: pii-v6`）、`/api/models`、`/api/state`（快照结构完整）、`/api/cwd`、`/api/conversations` 全部 200
  - `/api/stream` 能收到 `event: state` SSE 帧
- 临时实例已停止，未改动线上环境与仓库 git 历史。

### 尚未执行

- 上线：需走 `deploy/self-update/pii-deploy.sh`，属破坏性操作，执行前须另行确认。
