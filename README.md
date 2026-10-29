# pii

自托管的 durable agent。底座是 [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable)，
模型直接复用你 `~/.pi/agent/models.json` 里的 provider，前端是 React + Tailwind + shadcn/ui。

## 为什么是 pi-durable

| 需求 | pi-durable 提供 |
|---|---|
| 手机和 Mac 看同一个会话 | 权威快照 + 变更订阅 |
| 关掉浏览器它还在跑 | 任务在服务端，不依赖连接 |
| 进程崩了能接上 | 每一步存 checkpoint，重启续跑 |
| 断了重连不丢 | 快照是权威，事件只是提示 |

## 目录

```
src/
├── provider.ts        models.json → pi-ai 的 Models（pi-durable 自己不读 models.json）
├── agent.ts           打开 Harness + root conversation，调 resume() 开启调度
├── stage0.ts          最小验证：命令行问一句
├── tools/
│   └── approval.ts    beforeTool hook → 阻塞等待浏览器点头
└── server/
    ├── main.ts        Hono: HTTP + SSE + 静态托管 + pid 锁
    ├── approvals.ts   审批中转站（挂起 / 超时 / 关闭全拒，每个审批带 conversationId）
    ├── policies.ts    每个会话的工具白名单（哪些工具免问）+ 预设档位
    ├── conversations.ts  多会话：列表 / 新建 / 打开（标题优先自定义，否则从第一条用户消息推）
    ├── titles.ts     自定义会话标题（用户改名后落 conversation-titles.json，覆盖自动标题）
    ├── push.ts        Web Push：VAPID 密钥 + 订阅表 + 发送/剪枝
    ├── project.ts     ConversationView → 前端 JSON（含 pi.live 的流式半截投影）
    └── page.ts        阶段 2 的降级测试页（没构建前端时用）
├── tools/
│   ├── approval.ts    beforeTool → 阻塞等浏览器点头
│   └── notify.ts      GenerationTask.onYield → 「回答完成」推一条

web/                   前端（Vite + React + TS + Tailwind v4 + shadcn/ui）
├── src/App.tsx              布局 + `?c=<id>` 路由 + 会话切换
├── src/hooks/usePii.ts        连接 + 快照 + 审批状态（绑定一个会话）
├── src/hooks/useConversations.ts  会话列表 / 新建
├── src/hooks/usePolicy.ts     当前会话的审批策略（读 / 改）
├── src/lib/api.ts             fetch + EventSource（都带 `?c=`）
├── src/lib/push.ts            申请权限 / 订阅 / 退订
└── src/components/
    ├── ConversationsPanel.tsx  桌面侧栏 + 手机抽屉
    ├── PermissionPicker.tsx    工具执行权限：预设档位 + 逐工具开关
    ├── PushToggle.tsx          状态栏上那个铃铛
    ├── StatusBar.tsx           连接状态 + 会话标题（点一下可改名）+ token
    ├── chat/Transcript.tsx
    ├── chat/LiveRow.tsx       正在发生的那一行：流式正文 + Thinking… + 工具运行提示
    ├── chat/EntryRow.tsx
    ├── chat/Markdown.tsx        react-markdown + GFM，禁 HTML/远程图
    ├── chat/CodeBlock.tsx       带复制按钮
    ├── chat/ThinkingBlock.tsx   默认折叠 + hover 摘要 + 点击展开
    ├── chat/ToolCallCard.tsx    折叠成一行「工具名 + 目标」
    ├── chat/ToolResultBlock.tsx 折叠预览，错误标红并默认展开
    ├── chat/Composer.tsx
    └── ApprovalCards.tsx        倒计时 + 允许/拒绝

scripts/shot.mjs        用 CDP 截图 + 抓控制台错误（无 puppeteer 依赖）
scripts/pwa-check.mjs   用 CDP 自检 manifest / service worker / 图标
scripts/tailscale-setup.sh  把本地 8787 挂成 tailnet 内的 https 地址
```

## 跑

```bash
npm install
npm --prefix web install

npm run stage0 -- "用一句话介绍你自己"   # 阶段 0：验证模型链路
npm run build:web && npm start           # 生产：服务端托管 web/dist，http://127.0.0.1:8787

# 开发（两个终端）
npm start                                # 终端 A：服务端 :8787
npm run dev:web                          # 终端 B：Vite :5173，/api 代理到 8787
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PII_PORT` | `8787` | HTTP 端口 |
| `PII_HOST` | `127.0.0.1` | 监听地址（要让手机连，设 `0.0.0.0` 或走 `tailscale serve`） |
| `PII_DATA_DIR` | `~/.pii` | 数据目录（`agent.sqlite` + `server.lock`） |
| `PII_CWD` | 启动目录 | 默认工作目录（bash/read/write 的根）；每个会话还能在界面里单独改 |
| `PII_PROVIDER` | `magpie` | 来自 `~/.pi/agent/models.json` |
| `PII_MODEL` | `workbuddy/deepseek-v4.1-flash` | 同上 |
| `PII_TOOLS` | 开 | `0` 关闭 read/write/edit/bash |
| `PII_AUTO_ALLOW` | `read` | **默认**审批策略：逗号分隔的工具名，设空=全问，含 `*`=全部放行。仅当会话没在界面上单独配过时生效（界面按会话可覆盖） |
| `PII_THINKING` | 不设 | 设成 `low`/`medium`/`high` 才会出现思考块 |
| `PII_PUSH` | 开 | `0` 关闭推送（不生成密钥、不发送） |
| `PII_VAPID_SUBJECT` | `mailto:pii@localhost` | VAPID 的联络人；部分推送服务会校验 |

## API

会话用 query 参数选（`?c=<id>`），不传就是 root。之所以不用路径段：
`EventSource` 设不了请求头，query 是它唯一能带上下文的地方。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 前端（有 `web/dist` 就用它，否则降级到测试页） |
| GET | `/api/conversations` | 会话列表：`[{ id, title, busy }]`，最新在前（title 优先用自定义） |
| POST | `/api/conversations` | 新建会话，返回 `{ id, title }` |
| PATCH | `/api/conversations/:id` | 重命名：`{ title }`；空串 = 恢复自动标题 |
| GET | `/api/policy?c=` | 当前会话的工具审批策略 + 对应预设 |
| POST | `/api/policy?c=` | 改当前会话的策略：`{ policy: { auto, allowUnknown } }` |
| GET | `/api/state?c=` | 权威快照（含 `conversationId`） |
| GET | `/api/stream?c=` | SSE：`state` / `approval` / `approval-resolved` / `ping` |
| GET | `/api/approvals?c=` | 当前挂起的审批（重连补发用，按会话过滤） |
| POST | `/api/prompt?c=` | `{ text, requestId? }`；`requestId` 保证幂等 |
| POST | `/api/approve` | `{ id, allow }` 回答一个审批 |
| POST | `/api/abort?c=` | 中断该会话当前的运行 |
| GET | `/api/models?c=` | 可选模型清单（70 个）+ 当前会话用的那个 |
| POST | `/api/model?c=` | `{ provider, modelId }` 切换本会话模型 |
| GET | `/api/cwd?c=` | 本会话的工作目录 |
| POST | `/api/cwd?c=` | `{ path }` 切换工作目录（校验存在且是目录） |
| GET | `/api/fs?path=` | 列子目录（选目录用；只列目录不列文件，顺带报文件数） |
| POST | `/api/client-metrics` | 页面自报视口/安全区（排查真机布局用） |
| GET | `/api/client-metrics` | 最近 20 条上报 |
| GET | `/api/push/key` | `{ publicKey, enabled }`（浏览器订阅要用公钥） |
| POST | `/api/push/subscribe` | `{ endpoint, keys, conversationId? }` |
| POST | `/api/push/unsubscribe` | `{ endpoint }` |
| POST | `/api/push/test` | 自测：立刻推一条，不用等模型跑完 |

## 数据存在哪

全部在 `PII_DATA_DIR`（默认 `~/.pii`），560KB 左右：

| 文件 | 内容 |
|---|---|
| `agent.sqlite` | **全部对话**：会话、条目、文档、任务、提交记录 |
| `agent.sqlite-wal` / `-shm` | SQLite 的 WAL 与共享内存，正常存在，别手动删 |
| `vapid.json` | 推送密钥对（删了等于所有设备要重新订阅） |
| `push-subscriptions.json` | 推送订阅表 |
| `server.lock` | pid 锁，防重复启动 |
| `hidden-conversations.json` | 已删除的会话 id（删干净后会自动划掉） |

数据库里就这些表，`entries` 是消息本体（`record` 列是 JSON）：

```bash
sqlite3 ~/.pii/agent.sqlite "select count(*) from conversations"   # 会话数
sqlite3 ~/.pii/agent.sqlite "select conversation_id, count(*) from entries group by 1"
sqlite3 ~/.pii/agent.sqlite "select record from entries order by id desc limit 1" | head -c 400
```

**备份 / 迁移**：直接拷 `~/.pii/`（服务停掉再拷，不然 WAL 里可能有未合并的页）。
**清空重来**：`rm -rf ~/.pii`（会话、订阅、密钥全没）。

## 工作目录（让 agent 在哪干活）

`bash` / `read` / `write` / `edit` 都跑在一个**工作目录**里，这决定了它能碰哪些文件：

```
会话的 pi.agent.cwd  →  NodeExecutionEnv({ cwd })  →  bash 的 pwd / 相对路径的起点
```

三层控制，从粗到细：

| 层面 | 怎么设 | 适用 |
|---|---|---|
| 默认值 | 启动时的目录，或 `PII_CWD=/path npm start` | 你只有一两个项目 |
| 每个会话 | 界面底部那个文件夹 chip → 选目录 → 「用这个目录」 | 一个会话一个项目，互不干扰 |
| API | `POST /api/cwd { path }` | 脚本/自动化 |

**不同会话可以有不同工作目录**，这就是多会话真正的用处：
会话 A 挂在 `~/code/foo`，会话 B 挂在 `~/code/bar`，同时跑，各自 `pwd` 各自的项目。

安全边界要说清楚：`cwd` 只影响**相对路径**的解析。写绝对路径（`/etc/passwd`）依然可达，
真正的闸门是工具审批（`beforeTool` 阻塞等点头）。cwd 是「方便」，不是「沙箱」。

## 多会话

pi-durable 一个 conversation 只有 `id` / `parent` / `owner`，**没有标题字段**。
所以「侧栏里那行字」不是存储，是投影：

```
会话列表 = storage.scanConversations(最新在前)
  ├─ title  → 该会话第 1 条 pi.user 的前 42 个字（没有就「新对话」）
  └─ busy   → harness.inspect() 里还有未结算提交，就是「有活没干完」
```

这样做的代价：列表每刷一次要 N+1 次查询（N = 会话数，上限 50）；
好处：**标题默认永远和内容对得上**，因为它是从内容里算出来的。

### 重命名

标题默认从内容推，但允许手动覆盖：点顶部标题行内改名（回车/失焦保存、Esc 取消），
或 `PATCH /api/conversations/:id { title }`。自定义标题落 `conversation-titles.json`
（和 `hidden-conversations.json` 一样是纯文件），**不改库表、不动 Harness**；
传空串就清掉这个 key、退回全自动。列表与推送都优先用自定义标题。

审批也必须带会话归属。不带的后果很具体：你在 B 会话里发消息，
A 会话里挂着的 `rm` 审批弹到你脸上，你顺手点了「允许」。
所以 `ApprovalRequest.conversationId` 是必填项，`/api/approvals?c=` 和 SSE 都按它过滤。

前端路由就一个 query：`?c=<id>`。`history.replaceState` 写回地址栏，
于是刷新、分享链接都落回同一个会话 —— 省掉一个 router 依赖。

**但 PWA 冷启动不是**：主屏幕图标启动会回到 manifest 的 `start_url`（`/`，不带 `?c=`），
URL 里没会话就只剩 root。所以当前会话 id 走**两层持久化**，启动时「URL 优先，没有就恢复」：

1. `localStorage`（`pii:last-conversation`）—— 快，普通浏览器够用；
2. 服务端 `last-conversation.json`（`GET/POST /api/last-conversation`）—— **兜底**。
   iOS 独立 PWA 上 localStorage 不可靠（可能被清/隔离），URL 和本地都没有时就向服务端要。

切会话时两边都写。恢复的会话若已被删，列表加载完且未被 50 条上限截断时会退回 root。

> iOS 独立 PWA 有时会一直赖着旧版（service worker 缓存不更新）。SW 已改成
> `updateViaCache:none` + 回前台检查更新 + 新 SW 接管时自动刷新；实在不更新时，
> 把图标从主屏幕删掉、用 Safari 重新打开网址再“添加到主屏幕”即可强制拿新版。

### 删除会话

界面上是两段式：点垃圾桶 → 这一行变成「删除「xxx」？删除 / 取消」→ 再点删除。

服务端分两步，各管一件事：

```text
① 立刻藏起来    hidden-conversations.json + 内存里的 Set
                → 列表不出现、GET/POST 一律 404（秒生效，不依赖删行成功）
② 真删行        一个事务里删 6 张表
                document_revisions → documents → entries → submissions → tasks → conversations
                → 成功才把它从名单里划掉；失败就留着，**下次启动时重试**
```

为什么不当场硬删了事：**Harness 在内存里缓存着会话的文档和上下文**，
正在打开时删表，下一次自动续跑会往一个已不存在的会话里写东西。所以服务端会拒绝：

| 情况 | 返回 |
|---|---|
| 删 root | `400 root 会话不能删` |
| 这个会话还有 SSE 连着（你在看） | `409 先切到别的会话再删` |
| 还有没跑完的任务 | `409 等它结束再删` |

前端因此按「先切走 → 等 0.5 秒让旧 SSE 断开 → 再发 DELETE」的顺序做。

## 工具审批

`beforeTool` hook **允许返回 Promise**，所以拦截是真的阻塞的 ——
工具任务停在原地等浏览器点头，不是「先拒绝再让模型重试」。

```
agent 要跑 bash
  → beforeTool 挂起（最多 120 秒）
  → SSE: event=approval { id, conversationId, tool, input, expiresAt }
  → 页面底部弹卡片，点「允许 / 拒绝」
  → POST /api/approve { id, allow }
  → 允许：执行；拒绝：工具结果写入 "Tool call blocked: …"
  → 超时 / 服务关闭：一律拒绝（fail-closed）
```

注意：审批的超时是 **120 秒**。如果你在用脚本测试，只盯 `/api/state` 是永远看不到审批的 ——
审批不写在快照里，它在 `/api/approvals` 和 SSE 的 `approval` 事件里。

### 按会话配置审批策略

「每个工具都点一次」太烦，所以每个会话有一张**工具白名单**，决定哪些工具免问、直接跑。
在输入框底部的「权限」chip 里改，只影响当前会话，落 `conversation-policies.json`（纯文件）：

| 预设 | read | write/edit | bash | 说明 |
|---|---|---|---|---|
| 逐个确认 | 问 | 问 | 问 | 全问，最保守 |
| 只读自动 | 自动 | 问 | 问 | 默认 |
| 改文件自动 | 自动 | 自动 | 问 | bash 仍把关 |
| 全部放行 | 自动 | 自动 | 自动 | 危险，含未来新工具也自动 |

「高级」里还能单独开关每个工具（组合出「自定义」）。未列出的新工具只有在「全部放行」时
才自动，其它模式一律走询问（fail-safe）。

`autoAllow` 命中就在 `ApprovalBroker.request()` 里直接放行（不产生 approval 卡片）；
否则照旧挂起等人点头。

## 流式输出与思考

正文走 SSE **流式**；思考与工具执行**不流式刷屏**，只给一行带用时的状态。走的还是那条 SSE（没有第二条事件通道）：

```
模型生成
  → pi-durable 每 ~100ms 把「半截」提交进 pi.live.generation.message
  → 服务端 state.subscribe 每帧推一份快照（project.ts 把 pi.live 投影成 live.phase + live.message.blocks）
  → 前端 LiveRow 只拿其中的正文块持续重渲染 → 看起来就是一个字一个字冒出来
```

`live.phase`：`generating`（在生成）/ `tools`（在跑工具）。实时区的显示规则：

| 当前状态 | 实时区只显示 |
|---|---|
| 思考中（还没出正文） | 🧠 紫色脉冲 `Thinking… 3s`（**进行中只显示用时，不显示字数**） |
| 在调用/执行工具 | ⚙️ 琥珀色旋转 `Working… 2s` |
| 正在输出正文 | 正文流式 + 光标 |

思考用**大脑+脉冲**、工具用**齿轮+旋转**，颜色也不同（紫/琥珀）。

**进行中只显示用时；结束后才显示字数+用时**：
- 思考块（`ThinkingBlock`）折叠行：`思考 · 531 字 · 用时 3s`。字数来自落定的 thinking 文本；
  用时：**前端实时计时**（从进入 thinking 到离开）最精确，优先用；历史消息（首页加载的旧对话）
  没有这份计时，就由服务端用该条消息生成任务的 `startedAt/endedAt`（`tasks` 表，只读连接 + 缓存）
  给一个近似值兑底——所以历史思考块也能显示大致用时。
- 工具卡片（`ToolCallCard`）折叠行：`bash cmd… · 26 字 · 0.03s`。结果字数来自并进来的 `result`，
  用时来自 `pi.tool-result` 落定的 `durationMs`。

思考内容和工具参数/结果**不在实时区逐字展示**——生成结束、消息作为 entry 落定后，
思考块（`ThinkingBlock`）和工具卡片（`ToolCallCard`/`ToolResultBlock`）都以**默认折叠**的形式保留在正文里，
需要时再展开看。

代价是每帧发完整快照（见「已知简化」）——换来的是实现简单、语义和快照一致。

## 通知（Web Push）

推送在服务端就三块拼图：

```
VAPID 密钥对（~/.pii/vapid.json，首次启动生成，0600）
   └─ 向推送服务证明「我是这个应用」，不然谁都能往你的 endpoint 发
订阅表（~/.pii/push-subscriptions.json）
   └─ endpoint（门牌号）+ p256dh/auth（加密用）
发送（web-push）
   └─ payload 是加密的：推送服务只负责送，看不懂内容
```

**什么时候推**

| 触发点 | 在哪 | 文案 |
|---|---|---|
| 有人要你点头 | `main.ts` 里的 `approvals.onRequest` | `bash: {"command":"…"}` |
| 回答跑完了 | `tools/notify.ts` 挂 `GenerationTask.onYield` | 回答前 120 字 |

两个刻意的设计：

1. **你正在看就不推**。`?c=` 的 SSE 连接计数（`watching`）为 0 才发 —— 否则你盯着屏幕
   看它跑完，手机还要震一下，纯噪音。
2. **同一会话用同一个 `tag`**。新通知直接替换旧的，不会一个会话刷出十条。

**三个前提，缺一个就整条路走不通**

| 前提 | 说明 |
|---|---|
| 安全上下文 | `https://` 或 `http://localhost`。手机上 `http://192.168.x.x` 不行 |
| SW 已激活 | 推送是 service worker 收的，页面只是代理人 |
| 权限 granted | 必须从**点击**里调 `requestPermission()`（Safari 硬要求） |

iOS 多两条：16.4 起才支持，而且**必须先「添加到主屏幕」再从图标进入**。
所以想真机验推送，还是绕不开 Tailscale 那一步。

**怎么验**

最快的自测（不用等模型）：

```bash
curl -sX POST localhost:8787/api/push/test -H 'content-type: application/json' -d '{}'
# {"sent":1,"pruned":0,"failed":0}
```

想看密文长什么样：起一个 https 的假推送服务（web-push 拒绝 http endpoint），
订阅时把 `endpoint` 指向它，就能收到 `Authorization: vapid t=…` + 一段 250～450 字节的密文。

## 界面上的几件事（都有原因）

| 细节 | 为什么这么做 |
|---|---|
| **时间戳分隔线** | entry 本身没有时间字段，时间在消息里（`message.timestamp`）；所以取该条第一条带时间戳的消息。间隔 ≥5 分钟才插一条居中时间线（`14:03`，比每条都挂时间干净） |
| **消息时间戳** | 每条消息底部：**当天只显示时分秒**（`09:03:07`），**不是当天再加年月日**（`2026-10-28 09:03:07`） |
| **总任务时长** | 一轮任务（用户消息 → 最终回答，含思考/工具）的墙钟时长，显示在**最终回答底部的时间戳后面**：`09:03:07 · 用时 1m23s`（<60s 用 `Xs`） |
| **引用** | 点消息右侧的引号 → 输入框上方出现引用条 → 发送时拼成 markdown 引用块（`> …`）。**不改存储结构**：模型看得见、历史里也读得懂 |
| **工具卡片** | “命令 + 结果”合并成**一个可折叠块**：折叠只留一行（工具名 + 命令摘要 + 结果字数 + 耗时 + 成/错图标），展开看完整命令与结果。原因：pi-durable 里调用在 assistant entry、结果在后面的单独 `pi.tool-result` entry；服务端 `project.ts` 按 `toolCallId` 把结果并进 toolCall 块，前端只渲染一个卡片 |
| **禁用双指缩放** | `user-scalable=no` + `maximum-scale=1`（iOS Safari 不认这两个，所以还要拦 `gesturestart/gesturechange/gestureend`）+ `html { touch-action: pan-y }`。横向滚动的容器单独加 `.allow-x-pan`，否则会被锁死 |
| **发送键** | 三态：可发送时是白底深色箭头，不可发送是淡灰；**运行中且输入为空**→红色暂停键（中止当前生成）；**运行中且输入了文字**→发送（排队 followUp）\+ 一个 ⚡ 插队键（steer，打断当前回合立即处理） |
| **输入框** | 有一个看得见的框（border + `bg-card/60`），聚焦时描边高亮 —— 之前它会和背景糊在一起 |

## 锁屏之后还能用吗（默认已经处理好）

服务启动时会自己起一个 `caffeinate -i -s -w <自己的pid>`：

```
caffeinate -i   阻止空闲睡眠（屏幕黑了也照跑）
caffeinate -s   接着电源时阻止系统睡眠
-w <pid>        绑在服务进程上：服务退出它立刻退出，不会留下“忘了关”的唤醒锁
```

启动日志里能看到一行 `睡眠  阻止省电睡眠（锁屏照跑；合盖仍会睡）`，
`pmset -g assertions` 里能看到 `PreventUserIdleSystemSleep 1`。

```text
锁屏（Ctrl+Cmd+Q）  → 照跑，手机照连                        ✅
关显示器 / 息屏      → 照跑                                  ✅
空闲睡眠             → 已被 caffeinate 拦住                   ✅
合上盖子             → 仍然会睡（macOS 策略：除非接电源+外接显示器）  ⚠️
```

所以日常用法就一句：**锁屏，别合盖。**

不想让它拦睡眠：`PII_KEEP_AWAKE=0 npm start`。
也可以手动 `npm run nosleep`（= `caffeinate -is npm start`），但没必要了。

## 只用手机改项目：四步

```text
1. 底部 📁 chip → 选到项目目录（agent 的 bash/read/edit 都相对它解析）
2. 底部绿点 chip → 选模型（大改动选强的，小修小补选快的）
3. 说清楚改哪里：「src/server/main.ts 里的审批超时从 120 秒改成 300 秒」
4. 审批卡片会逐个弹出来（edit / write / bash）—— 点允许前看一眼改的是什么
```

两个习惯值得养成：

- **让它先 `git status` 再动手**：改完你能一眼看出动了哪些文件，随时 `git checkout .` 回滚
- **一次说一件事**：一轮里既改代码又跑测试又改配置，审批卡片会连着弹，容易点错

## 从手机改完代码，怎么让改动生效

分两种情况，区别在于**代码在不在进程内存里**：

| 改了什么 | 需要做什么 | 为什么 |
|---|---|---|
| 前端 `web/src` | 只构建（`npm run build:web`） | 产物在 `web/dist`，服务端每次请求都从磁盘读，不用重启 |
| 服务端 `src` | **必须重启** | tsx 没有热重载，代码在进程内存里 |

一条命令搞定两件事：

```bash
npm run apply      # = 构建前端 + 优雅重启服务端
```

### 优雅重启是什么意思

`POST /api/restart` 不会当场退出，而是**等所有会话空闲**再退：

```text
你说「改完了，生效」
  → agent 跑 npm run apply
  → 服务端标记 restartPending，返回 200
  → 它把这一轮回答写完（这一步不会被腰斩）
  → inspect() 显示没有排队提交、没有活动任务 → 退出
  → launchd 的 KeepAlive 立刻把它拉起来
  → 手机上的 SSE 自动重连，快照覆盖，会话内容一个不少
```

为什么不直接 `exit`：**你现在这条对话就跑在这个进程里**。立刻退出会把正在生成的回答腰斩，
重启后 pi-durable 从 checkpoint 续跑，很可能把「重启」这条命令再执行一遍 —— 变成重启环。
等空闲再退，这个坑就不存在了。

兜底（HTTP 都不通、代码写崩起不来时）：

```bash
./scripts/restart.sh --force        # = launchctl kickstart -k（硬重启）
```

### 怎么判断「要不要重启」

```bash
curl -s localhost:8787/api/build
# { "runningSince": …, "newestSourceMtime": …, "behind": true }
```

`behind: true` = 源码比运行中的进程新，需要重启。`false` = 跑的就是最新代码。

### 崩了会自己起来吗

会。服务由 launchd 托管（`KeepAlive` 无条件重启：崩溃、`kill -9`、优雅退出都算）：

```bash
npm run service:status     # 看 pid / 上次退出码 / 端口探测
npm run service:logs       # tail -f ~/.pii/pii.log
npm run service:install    # 安装（PII_VAPID_SUBJECT=mailto:you@x.com ./scripts/install-launchd.sh）
npm run service:uninstall  # 彻底停掉（之后 kill 不再被拉起）
```

实测：`kill -9` 和 `kill`（SIGTERM）之后都是 **1~2 秒**内新 pid 起来、接口恢复 200，数据完整。

注意 `KeepAlive` 是无条件的，所以：

```bash
kill <pid>                        # ❌ 会被立刻拉回来
launchctl bootout gui/$(id -u)/com.sevan.pii   # ✅ 这才是「停」 
```

## 部署到云服务器（VPS / Docker）

### 能搬吗：能，但有三件事会变

技术上一路畅通 —— 依赖里**没有任何原生模块**，SQLite 用的是 Node 内置的 `node:sqlite`，
唯一的 macOS 专属代码（`caffeinate` 保活）在 `awake.ts` 里已经按 `process.platform` 跳过。
我在 Mac 上用 Docker 真跑通过：构建 → 启动 → 鉴权 401 → 带令牌调模型拿到回复。

但有三件事和「跑在 Mac 上」不一样：

| 变化 | 说明 |
|---|---|
| **① 模型来源** | 关键约束。magpie 是 Mac 上的桌面 App（`/Applications/magpie.app`），在 `127.0.0.1:3425` 提供 OpenAI 兼容接口。**搬到 VPS 后那 56 个模型全部失效**（我从容器里实测：连不上）。见下方「模型怎么办」 |
| **② 文件世界** | agent 只能改**服务器上的文件**。要手机改项目 → 项目得 clone 到服务器（`WORK_DIR`），改完在服务器 commit/push，Mac 上 pull |
| **③ origin 变了** | 域名换了 → 手机上要**重装主屏幕图标、重新订阅推送**（推送订阅绑死在 origin 上） |

换来的好处也很实在：永远在线（不用管锁屏/合盖/睡眠）、不需要 Tailscale、
手机开着原来的 VPN 也能用 pii（不再抢 VPN 槽）。

### 模型怎么办

| 选项 | 可行性 |
|---|---|
| 加官方 API（DeepSeek / OpenAI / Anthropic / Gemini…） | ✅ 在 models.json 里加一个 provider（`baseUrl` + `apiKey`）即可，代码不用改 |
| 自建一个 OpenAI 兼容网关 | ✅ 只要服务器能访问到，baseUrl 指过去就行 |
| 让 Mac 继续当网关 | ⚠️ VPS 装 Tailscale，models.json 里 baseUrl 改成 `http://<Mac 的 tailnet IP>:3425`。能用，但 Mac 必须开机 —— “搬到服务器”的意义只剩一半 |

### 一条命令部署

仓库里已经有：`Dockerfile` / `docker-compose.yml` / `Caddyfile`。

```bash
# 1) 传代码（没有 git 仓库时用 rsync；注意排除 node_modules 和大目录）
rsync -av --exclude node_modules --exclude web/node_modules ./ user@服务器:/srv/pii/

# 2) 在服务器上写 .env
cd /srv/pii
cat > .env <<'EOF'
PII_DOMAIN=pii.example.com          # 这个域名的 A 记录要指向服务器 IP
PII_VAPID_SUBJECT=mailto:you@x.com  # Apple 推送会校验，必须真实
WORK_DIR=/srv/projects              # agent 干活的目录（项目 clone 到这）
EOF

# 3) 起
docker compose up -d --build
docker compose logs -f pii
```

三个容器级细节要知道：

- `pii` 容器**不发布端口**，只有 `caddy` 能连它 —— 对外只有 80/443
- `PII_AUTH=1` 写在 compose 里，**公网必须开**；令牌在 `docker compose exec pii cat /data/auth-token`
- `models.json` 是只读挂载进容器的（`~/.pi/agent/models.json`）。它里面有**明文密钥**，别进 git

**没有域名也能上**：用 `1.2.3.4.sslip.io`（把 IP 写成域名）当 `PII_DOMAIN`，
Caddy 照样能申请到真证书，PWA 和推送都能用。

### 镜像构建的小坑

Dockerfile 的基础镜像可以用参数换（国内服务器常用）：

```bash
docker build --build-arg NODE_IMAGE=node:22-alpine -t pii .
```

Node 版本必须 ≥ 22.19（`node:sqlite` 需要）。我在 `node:22-alpine`（v22.22.0）上验证过能跑。

## 为什么会话变长后会变慢（以及怎么治的）

症状：手机上打开老会话要转好几秒，生成过程中界面一直卡，首屏还三段跳（白屏 → 黑屏 → 内容）。

实测（会话 174：338 条 entry、4 张图）：

```
优化前：单帧快照 2,426 KB
现在：  单帧 63 KB → gzip 23 KB      （默认窗口 20 条）
```

根因不是网络，是**快照的设计**：pi-durable 的纪律是「快照是账单，每次变化整份推」，
而生成过程中 progress commit 每秒好几次。四处改动：

| 改动 | 做法 | 效果 |
|---|---|---|
| **图片移出快照** | 快照里只放 `/api/image?c=&e=&i=`，图片单独端点 + `immutable` 缓存 | 2.4MB → 1.6MB；第二次看同图 0 请求 |
| **快照窗口化** | 默认只发最近 **20** 条（`PII_SNAPSHOT_LIMIT` 可调），`?before=<id>` 往前翻 | 1.6MB → 63KB |
| **gzip** | `hono/compress`（自动跳过 SSE） | 63KB → 23KB |
| **SSE 节流** | 最多每 250ms 一帧，中间帧合并（丢的是旧快照，不是增量） | 生成时帧数降一个数量级 |

### 首屏：三层加速（白屏 3~4 秒的元凶在这里）

第一版只做了骨架，用户实测仍是「白屏 3~4 秒 → 骨架 → 10 秒才出内容」。查出来两个原因：

| 元凶 | 证据 | 修法 |
|---|---|---|
| 静态资源**没有缓存头** | `/assets/index-*.js`（624KB）响应里只有 `last-modified`，没有 `cache-control` → 每次冷启动都重新下载 | `Cache-Control: public, max-age=31536000, immutable`（文件名带指纹，安全） |
| SW 导航是**网络优先** | 冲门第一件事是等一个网络来回，而 Funnel 入口在境外（`tailscale netcheck` → 最近 DERP 在旧金山，148ms），手机走 VPN 再绕过去，单程 300~500ms | 改成**缓存优先 + 后台更新**（stale-while-revalidate），打开先给缓存壳 |
| SW 只缓存「经过它的请求」 | 首次安装时 JS/CSS 在 SW 激活**之前**就加载了，不在缓存里 → 第二次打开仍要下 600KB | 安装时读一次首页 HTML，把 `/assets/...` 抠出来 `addAll` 预缓存 |

实测（headless，模拟重开）：

```
① 安装完成：缓存里有 ["/", "/manifest.webmanifest", "/icons/icon-192.png",
                       "/assets/index-*.js", "/assets/index-*.css"]
② 冷启动：资源 2 个，零传输 2 个，传输字节 0
③ 再开一次：传输字节 0
```

也就是说**从第二次打开起，壳和 JS/CSS 一个字节都不用传**，只剩 `/api/state`（23KB gzip）和 SSE 握手两次往返。

顺带处理了一个新风险：缓存优先后，万一 cookie 过期，壳会照旧打开但 API 全 401。
所以 `api.ts` 里加了 401 → 跳 `/login`（`/login` 特意不缓存）。

### 首屏：两层骨架

```
第 0 帧   index.html 内联 <style> + #boot-skeleton
          → 浏览器还没解析到 JS 就已经是深色底 + 灰块（彻底没有白屏）
第 1 帧   React 挂载，快照还没到 → TranscriptSkeleton（同样的形状，带“正在连接…”）
第 2 帧   快照到达 → 原地替换成真内容
```

### 滚动按需加载：按「轮」而不是按「条」

```
首屏      最近 5 轮（一轮 = 用户消息 + 它之后的全部条目，通常 10~60 条）
上滑到顶  scrollTop < 320px 自动取更早的 5 轮
插入后    按 scrollHeight 差值补 scrollTop → 视野不跳
```

**为什么按轮切**：一条用户消息后面跟着思考、工具调用、工具结果、最终正文，可能 6~10 条 entry。
按条切会出现「切在半轮中间」——加载出一堆没有提问的思考，或者有提问没回答。按轮切永远完整。

实测：第一页 52 条 / 5 轮（首条是用户消息），第二页 78 条 / 5 轮，**两页零重叠**，`hasMore` 正确。

`PII_SNAPSHOT_TURNS` 可调（默认 5）。

加载时有动效（`LoadingOlder`）：三个骨架行 + 呼吸动画 + 「正在加载更早的消息」，
高度和即将插入的内容接近，不会突然跳一下。

### 顶栏那个黄点 / 红点是什么

**不是模型没连上，是「实时通道（SSE）还没接上」。** 两者要分清：

| 状态 | 点 | 顶栏文字 | 能不能发消息 |
|---|---|---|---|
| 快照已到，SSE 正在连 | 🟡 黄 | `连接中…`（手机上也会显示） | ❌ 输入框禁用，占位文案变「正在连接…（连上才能发送）」 |
| SSE 建立成功 | 🟢 绿 | 只显示绿点（窄屏不占位） | ✅ |
| 连接断了 | 🔴 红 | `断开，重连中…` | ❌ 同上 |

为什么必须禁：发消息走 `POST /api/prompt`，SSE 没连上时你看不到回复、也收不到审批卡片 ——
发了等于石沉大海。所以「没连上就发不出去」是故意的，底部还会提示「连接中，暂时发不出去」。

模型本身是好的：内容能显示（来自缓存快照或 `/api/state`）就说明后端活着。

### 历史按轮折叠

历史里一半以上是「思考 + 工具执行」，翻的时候满屏都是过程，真答案被埋掉。
现在按**轮**切分（一条用户消息 → 下一条用户消息），已结束的轮只留两行：

```
你的话
▸ 已完成 1m11s                                   ← 折叠，点开看思考 + 工具
它的最终回答
```

四条规则：

1. **折叠条只写「已完成 + 用时」**，不写“思考多少字/几个工具”—— 那些数字对回看没用
2. **折叠态下只有一行**：最终回答那条 entry 自带的 thinking 会被**挪进折叠区**，
   否则界面上会并排出现「已完成 5m16s」和「思考 · 2439 字」两行
3. **展开后看到「思考 + 工具调用/结果」**：过程里夹着的中间正文（“我先看一下…”）
   对回看没价值还吵，直接剔掉
4. **正在跑的那一轮才摊开过程**；跑完就折叠，包括最后一轮 —— 你只要最终正文

实测同一屏 DOM 里的消息节点从几十个降到 4 个。

需要注意的一个实现细节：图片端点的 `content-length` 千万别手算。我按
`base64 长度 × 3/4` 算过一次，因为 padding 差了 1 个字节，浏览器会一直等那个
不会来的尾巴 —— 表现是「图片能出来，但每次都要等 5 秒」。交给 Buffer 才对。

## 两个人同时改这个项目（重要）

这个仓库现在是「你（手机上的 pii agent）+ 我（Claude Code）」共同编辑的状态，会冲突。具体的冲突点：

| 操作 | 后果 |
|---|---|
| 我 `edit`（精确替换某段） | 如果那段已被手机改掉，**我会明确失败**（oldText 匹配不上），不会悄悄写坏 |
| 我 `write`（整文件覆盖） | **会静默覆盖**手机刚做的改动 —— 这是最危险的一种 |
| 手机 agent 改 `src/` 后不重启 | 它看到的是旧行为，可能“修”一个已经不存在的问题 |
| 两边同时构建 | `web/dist` 里多几个指纹文件（无害，因为 `emptyOutDir: false`） |

**已经做了的防护**：`git init` + 首次提交（97 个文件，`node_modules`/`web/dist`/运行数据都已忽略）。
现在任何一次改动都能看见、能回滚：

```bash
git status --short        # 谁改了什么
git diff                  # 具体改动
git checkout -- <文件>    # 丢掉某个文件的改动
git stash                 # 暂时收起所有改动
git log --oneline         # 历史
```

**建议的工作方式**（避免互相踩）：

1. **同一时间只让一边改**。手机在改前端，我就别动 `web/src`；我在改服务端，手机就等我说完
2. **改完立刻提交**：`git add -A && git commit -m "xxx"`。提交了就丢不了
3. **改服务端代码后必须 `npm run apply`**（或 `npm run restart -- --force`），
   否则手机看到的是旧行为
4. 我每次动手前会先 `git status`，发现有未提交的改动会先问你

## 历史不丢 + 上下文不爆（归档 + 压缩）

两个不同的东西，别混：

| | 干什么 | 存在哪 |
|---|---|---|
| **压缩**（compaction） | 上下文快到模型窗口时，把较早的部分换成摘要，让对话能继续 | 数据库（摘要是一条 entry） |
| **归档**（archive） | 把**原文**写成 markdown 落盘，**只增不改** | `<数据目录>/archive/<会话id>/` |

pi-durable 的压缩**默认就是开的**（`reserveTokens 16384` / `keepRecentTokens 20000`），
我们只需要在「摘要生成之前」把要被替换掉的原文存下来 —— 这就是 `beforeCompact` 钩子：

```text
上下文接近窗口
  → beforeCompact(entries = 即将被摘要替换的那些)
      → 归档成 0002-20261029-142433-compaction.md（只增不改）
  → 摘要生成、旧条目退出上下文
  → 对话继续，token 不会爆
```

实测（会话 174）：

```
POST /api/compact → taskId 1482
日志：归档 605 条 → ~/.pii/archive/174/0002-...-compaction.md   （1.5MB）
```

三个端点：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/archive?c=` | 手动导出当前会话全文（换模型/大改前留一份） |
| GET | `/api/archive?c=` | 列出归档文件 |
| GET | `/api/archive/file?c=&name=` | 读某个归档（只允许归档目录里的 `.md`，防路径穿越） |
| POST | `/api/compact?c=` | 主动压缩（平时自动触发，这个是手动腾地方） |

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PII_ARCHIVE_DIR` | `<数据目录>/archive` | 归档目录；指到项目里就是「项目里的会话存档文件夹」 |
| `PII_COMPACT_RESERVE` | 16384 | 给回答预留的 token；越小越早压缩 |
| `PII_COMPACT_KEEP` | 20000 | 最近多少 token 的原文保留不动 |
| `PII_COMPACT_OFF` | — | `1` 关闭自动压缩 |

## 手机 + PWA（阶段 4）

### 为什么必须要 https

iOS Safari 只在**安全上下文**里注册 service worker。而 secure context 只有：
`https://…` 或 `http://localhost` / `127.0.0.1`。

所以 `http://192.168.x.x:8787` 在手机上**加不到主屏幕**。Tailscale 的 `serve` 自动签证书，一步解决。

### 三步

```bash
# 1) Mac：服务照常监听 127.0.0.1（不暴露到局域网）
npm start

# 2) 另一个终端：挂到 tailnet 的 https 地址
npm run tailscale          # = bash scripts/tailscale-setup.sh
#   → https://<你的机器>.<你的 tailnet>.ts.net/

# 3) iPhone：装 Tailscale 登录同一账号 → Safari 打开那个地址
#    → 分享 → 添加到主屏幕 → 从主屏幕图标进入
```

撤掉：`npm run tailscale off`；查状态：`npm run tailscale status`。

### 实测踩过的四个坑（血泪，省你两小时）

| 坑 | 现象 | 真相 / 解法 |
|---|---|---|
| tailnet 默认没开 Serve | `Serve is not enabled on your tailnet`，并会给一个 `/f/serve?node=…` 短链 | 去 admin → Settings → Features 勾 Serve。**短链必须在 Mac 上点**——手机上开着 Tailscale 就没代理，那个域名被直连重置 |
| `serve` 会挂起 | 脚本卡死 120 秒 | 它先打印提示再等 stdin；要套 `timeout`，然后用 `serve status` 判成败（不看退码） |
| 图形版 CLI 不在 PATH | 明明装了却说“没找到” | CLI 在 `/Applications/Tailscale.app/Contents/MacOS/Tailscale`，脚本已自动找 |
| Mac 浏览器打不开 ts.net | `ERR_CONNECTION_REFUSED` 一片 | 浏览器走 Clash 系统代理，而 `*.ts.net` 是 tailnet 内部域名，代理节点在外面解析不到。绕代理 `curl --noproxy '*'` 就 200。解法：Clash 加 `DOMAIN-SUFFIX,ts.net,DIRECT`，或 Mac 上就用 `127.0.0.1` |

还有一条不是坑但很容易误判：**手机打不开时先看 `tailscale status`**。
iOS 只能同时开一个 VPN，切回 Clash 就把 Tailscale 踢下线了，
此时 `curl` 再快也没用——对端根本不在网里。

### 手机端的三个开关

| 开关 | 位置 | 不开的后果 |
|---|---|---|
| Tailscale 本身 | App 顶部开关 | 整台机不在 tailnet，什么都连不上 |
| Use Tailscale DNS（MagicDNS） | Tailscale App 设置 | 域名解析不出来，只能用 IP |
| iCloud 私人中继 | 设置 → Apple ID → iCloud | **不占 VPN 槽**，但会把 Safari 流量劫走，tailnet 域名静默失效 |

### PWA 自检

```bash
npm run build:web && npm start
# 另开一个有 remote-debugging-port 的 Chrome，然后：
CDP_PORT=9224 npm run pwa:check http://127.0.0.1:8787/
```

期望输出：manifest 200（`application/manifest+json`）、4 个图标全 200、
`swRegistrations: 1`、`swState: "activated"`、`secureContext: true`、控制台无错。

### service worker 做了什么/不做什么

| 做 | 不做 |
|---|---|
| 让页面可安装（有 fetch handler 是前提） | **不缓存 `/api/`**（快照是权威，缓存会显示过期状态） |
| 离线时回退到缓存壳 | 不碰 SSE 流 |
| 缓存带指纹的 `/assets/*` | 不预缓存会话数据 |

### 局域网直连（不装 Tailscale 的退路）

```bash
PII_HOST=0.0.0.0 npm start     # 手机访问 http://<Mac 的局域网 IP>:8787
```

能用，但**没有 PWA、没有独立窗口、没有麦克风** —— 因为是明文 http。

实测（2026-10-28）：`PII_HOST=0.0.0.0 PII_PORT=8788` 起一份独立实例（`PII_DATA_DIR=/tmp/pii-lan`），
从局域网 IP `http://192.168.5.86:8788` 访问 `/`、`/api/state`、`/manifest.webmanifest` 全部 200 ——
说明「绑定 + 路由 + 静态托管」这层没问题，**唯一缺的就是 https 这个安全上下文**。

## 已验证（都跑过真机）

- ✅ 模型链路：`provider.ts` 打通 `~/.pi/agent/models.json`（当前 70 个模型可用）
- ✅ 持久化：重启后会话还在（SQLite）
- ✅ SSE：一次提问收到多个 `state` 事件 + 心跳
- ✅ **崩溃恢复**：`kill -9` 打断生成 → 重启 → 自动续跑；被切断的回答留在 transcript，重试另起一条
- ✅ **工具审批·允许**：`bash pwd` → 挂起 → 允许 → 输出项目路径
- ✅ **工具审批·拒绝**：`bash whoami` → 挂起 → 拒绝 → `Tool call blocked: 用户拒绝了这个操作`
- ✅ **前端**：React 页面渲染、Markdown、代码块、工具卡片、审批卡片、思考块折叠，控制台零错误
- ✅ **PWA**：manifest 200、4 个图标全 200、service worker 已注册且 `activated`、`secureContext: true`
- ✅ **移动端布局**：390×844 下 top bar 不折行、输入框避让安全区、思考块与工具卡片正常
- ✅ **多会话**：新建 → 继承 root 的模型/cwd → 发消息 → 审批 → 回答；
  审批按会话隔离（`?c=83`: 1 条，`?c=1`: 0 条）；root 条目数 33 → 33（不串台）；
  重启后三个会话都在；桌面侧栏、手机抽屉、切换后抽屉自动关闭，控制台零错误
- ✅ **局域网直连退路**：`PII_HOST=0.0.0.0` 下局域网 IP 可达（见上）
- ✅ **Web Push·服务端**：自签 https 假推送服务真收到 `Authorization: vapid t=…` + 251～426 字节密文；
  410 自动剪枝（订阅表变回空）；SSE 连着时 `sent: 0`（不打扰正在看的人）；
  审批与「回答完成」两个触发点各推一条（真跑 bash 触发）
- ✅ **Web Push·客户端**：铃铛点击后浏览器真的生成了 FCM 订阅并上报服务端；
  SW 收到 push 后 `getNotifications()` 里能读到 `{title, body, tag, data.url:"/?c=83"}`；
  坏 payload（非 JSON）不会丢通知，退回默认文案
- ⏳ **Web Push·真机送达**：headless Chrome 的 FCM 订阅被服务端判为 410（无真实推送会话），
  真机送达仍需 https + 安装到主屏幕（同样是 Tailscale 那步）
- ✅ **切模型**：会话 98 切到 `magpie/auto/gemini-3.8-flash` → `pi.agent.model` 变更、
  `pi.usage` 记在新模型名下；`/api/models` 返回 70 个模型（56 个支持图片）
- ✅ **传图**：上传一张截图 → 图片进了 `entries` 的 model content（`type: "image"`）→
  模型准确描述了图里的内容（「手机端深色模式下的对话界面…输入框被红圈标出」）
- ✅ **工作目录**：切到 `~/ai-tasks` 后 `bash pwd` 输出 `/Users/sevan/ai-tasks`；
  不存在 / 非目录的路径都被拒；**别的会话 cwd 不受影响**
- ✅ **时间戳**：37/37 条 entry 都拿到了 `at`（来源：消息自带的 `timestamp`）
- ✅ **引用**：点引号 → 引用条 → 发出后是 markdown 引用块（`> …`）
- ✅ **删除会话**：新建会话发一句 → 开 SSE 时删返回 409 → 关掉后删成功 →
  列表消失、`/api/state` 404、**库里 0 条孤儿 entries**；删 root 被拒
- ✅ **改项目（手机上）**：cwd 指到 `/tmp/pii-demo`，说「把 hello.txt 的 World 改成 PII」→
  审批 `edit` + `bash` → 文件真的变成 `Hello PII`，全程只靠对话
- ✅ **可迁移到 VPS**：本机 Docker 真构建 + 真启动（node:22-alpine），
  鉴权 401/令牌 200 正确；容器内调用模型拿到回复（`host.docker.internal` 指向宿主 magpie）；
  唯一硬约束是模型后端必须从服务器可达
- ✅ **快照瘦身**：会话 174（338 条 + 4 图）单帧 2,426 KB → **23 KB**（窗口 20 条 + gzip + 图片外置），降 99%；
  `/api/image` 首字节 2~14ms、带 immutable 缓存；翻页游标正确（885→1186）
- ✅ **首屏骨架**：`index.html` 内联骨架 + React 骨架两层，白屏消失
- ✅ **秒开（快照缓存）**：上次快照存 localStorage（约 56KB），打开先渲染再后台刷新；
  2 秒人工延迟下「打开→看见内容」**176 ms**（无缓存时 5~6 秒）；实测每请求分段：
  `models 407ms / conversations 554ms / policy 415ms / sse-open 420ms / firstState 660ms`（400ms 延迟下）
- ✅ **静态资源缓存**：`/assets/*` → `immutable`（624KB 的 JS 只下过一次）；
  SW 导航改缓存优先 + 安装时预缓存带指纹资源 → **第二次打开起传输 0 字节**
- ✅ **Funnel 链路瓶颈定位**：`tailscale netcheck` 显示最近 DERP 在旧金山（148ms），
  手机经 VPN 绕境外入口，单程 300~500ms —— 这是「10 秒」的区域性原因，
  根治办法是部署到国内云服务器（见「部署到云服务器」）
- ✅ **滚动按需加载**：滚到距顶 320px 自动取下一页，插入后补 `scrollTop`（视野不跳）
- ✅ **按轮窗口**：首屏 5 轮（52 条），上滑再取 5 轮（78 条），两页零重叠；加载有骨架动效
- ✅ **归档 + 压缩**：`POST /api/compact` 触发压缩前，`beforeCompact` 钩子把 605 条原文
  归档成 1.5MB markdown（只增不改）；手动归档 338 条 → 1.2MB
- ✅ **折叠只有一行**：折叠态下不再并排出现「思考 · N 字」（最终回答自带的 thinking 挪进折叠区）；
  实测折叠条 3 个、折叠态下思考行 0 个、展开后思考行 1 个 + 工具卡
- ✅ **历史按轮折叠**：已结束的轮只留「你的话 + 最终回答」，过程折成「已完成 1m11s」；
  展开只含思考 + 工具（中间正文剔除）；只有正在跑的那轮摊开；同屏消息节点从几十降到 4
- ✅ **连接状态可见**：黄点/红点时顶栏显式显示「连接中…／断开，重连中…」，
  输入框禁用且占位变「正在连接…（连上才能发送）」，底部提示「连接中，暂时发不出去」
  （实测：挡住 `/api/stream` → 内容仍显示、输入禁用、顶栏红字）
- ✅ **自动重启**：`kill -9` / `kill`（SIGTERM）后 1~2 秒内由 launchd 拉起，接口恢复 200、数据完整
- ✅ **优雅重启**：`POST /api/restart` → `waiting-for-idle` → 2 秒后重启，
  `/api/build` 的 `behind` 从 true 翻回 false
- ✅ **推送 403 修复**：Apple 推送服务拒绝 `mailto:pii@localhost` 这种假 VAPID 联络人，
  换成真实邮箱后 `{"sent":1}`
- ✅ **锁屏照跑**：服务自起的 `caffeinate -i -s -w <pid>` 生效
  （`pmset -g assertions` → `PreventUserIdleSystemSleep 1`、`sleep prevented by caffeinate`）；
  服务退出时 caffeinate 自动退出，不留唤醒锁
- ✅ **Tailscale + https 真机**：`https://sevanmacbook-pro.tail09c941.ts.net` → Let's Encrypt 真证书；
  手机在 tailnet 内 **direct 直连（IPv6 打洞，41ms）**；`pwa:check` 全绿
  （`secureContext: true`、`swState: activated`、4 个图标 200、控制台无错）
- ✅ **真机 Tailscale 全链路**：手机在 tailnet 内直连、`https://…ts.net` 打开、添加到主屏幕、
  通知权限授予成功（截图 01:59 `已开启通知`）

## 已知简化

- `projectView()` 现在默认只发最近 80 条（`?limit=0` 要全量）；再往上还是整份窗口重传，
  真做增量 ops 能进一步省流量（语义不变，但工程量大一个量级）
- 没有鉴权；靠 `127.0.0.1` 或 `tailscale serve` 隔离
- 多会话只做了「列表 / 新建 / 切换 / 重命名 / 删除」：不能归档、搜索；列表上限 50 条（无分页）
- 标题默认来自第一条用户消息（没发过消息的叫「新对话」），但可以手动改名覆盖
- 切会话会断开旧 SSE 再连新的（没做「同时订阅多个会话」）
- 审批表在内存里：服务重启后挂起的审批会随任务重跑，需要重新点一次
- 推送没有偏好设置：没有免打扰时段、不能按会话静音、单设备一个订阅（多设备要多订几条）
- 前端 574 kB（未做 code split）
