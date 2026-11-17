/**
 * `subagent` 工具：派一个子 agent 去干一件独立的事。
 *
 * 多 agent 在 pi-durable 里不需要第二个进程 —— **一个 subagent 就是一个普通的 conversation**，
 * 只是所有权挂在「这次工具调用」这张工单上：
 *
 *     ownership: { kind: "task", taskId: api.taskId }
 *
 * 于是父会话 abort 时，子会话的 run 会顺着 ownership 树一起被撤；
 * 而子会话有自己的上下文、模型、工作目录 —— 上下文隔离和并行都从这里来。
 *
 * 六条纪律：
 *  1. **只回最终答案**：子 agent 的中间过程留在它自己的会话里，父会话只拿到一段结论，
 *     否则「省上下文」这件事就白做了。
 *  2. **崩溃后复用，不重开**：工具标了 `replay: "safe"`，进程崩了重跑时用 `memo` 里记的
 *     子会话 id，配合固定的 `requestId` —— 同一个 prompt 不会被投递第二遍。
 *  3. **子 agent 不能再派子 agent**：子会话的工具集里滤掉了自己，避免无限套娃（成本是乘法的）。
 *  4. **读答案走 `answer` 那条 entry**：`submission.wait()` 的 receipt 里 `answer` 就是最终答案的
 *     entry id，一次主键读取，比翻 entries 便宜也更准（和 stage0.ts 同样的读法）。
 *  5. **任务是一份契约**：goal / deliverable / materials / acceptance / constraints。
 *     子 agent 看不到父的对话、也不能反问，所以任务必须自足；
 *     材料优先给路径（共享 cwd，它自己能读），不要把大段内容贴进 prompt。
 *  6. **有上限地跑**：超时（默认 5 分钟）会真的 `abort` 子会话，不然它会占着并发名额烧 token；
 *     `readOnly` 把工具裁到只剩 `read`（话术挡不住越权，工具集才挡得住）；
 *     进度写进 `api.output()` —— 父界面上能看到它在第几轮跑什么，而这些不会进父的模型上下文。
 */
import {
  AssistantEntry,
  defineExtension,
  defineTool,
  type ConversationId,
  type Harness,
} from "@earendil-works/pi-durable";
import { bool, num, obj, opt, str } from "@earendil-works/pi-schema";

export interface SubagentOptions {
  /**
   * 拿到已经打开的 Harness。
   *
   * 为什么不直接传 Harness：扩展必须在 `Harness.open()` **之前**装进 registry（见 agent.ts），
   * 而创建子会话要的是打开之后的实例。用一个延迟读取的引用把这两件事错开。
   */
  getHarness: () => Harness;
}

/** 工具在 memo 里记子会话 id 的键名（同一次工具调用在重启后重跑时用得上）。 */
const MEMO_KEY = "subagent.conversation";

/**
 * 子 agent 的默认时限。
 *
 * 没有它，一个卡住的子 agent 会把父会话永久挂起（父在 `submission.wait()` 上等），
 * 而且它一直握着并发闸的名额 —— 3 个卡死的子 agent 就能让后面所有委派永远排队。
 * 超时不是"取消等待"，是真的 `handle.abort()` 把子会话停掉。
 */
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30 * 60_000;

/** `subagent` 返回给 UI 的结构化信息（界面上显示"这是哪个子会话、花了多少"）。 */
type SubagentDetails = {
  conversationId: number;
  /** 子会话消耗的 token 总数（含缓存读写；读 usage 时拿到多少算多少） */
  tokens?: number;
  /** 子会话的花费（provider 报了才有） */
  cost?: number;
  /** 超时被中止 */
  timedOut?: boolean;
  /** 没有答案时的原因 */
  error?: string;
};

/**
 * 造 details。
 *
 * 为什么不直接写字面量：`details` 要满足 JsonValue，而可选字段在字面量里会带
 * `undefined`（`{timedOut?: undefined}`），过不了索引签名。这里只放真正有值的键。
 */
function detailsOf(input: SubagentDetails): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = { conversationId: input.conversationId };
  if (input.tokens !== undefined) out.tokens = input.tokens;
  if (input.cost !== undefined) out.cost = input.cost;
  if (input.timedOut !== undefined) out.timedOut = input.timedOut;
  if (input.error !== undefined) out.error = input.error;
  return out;
}

/** 等一个 promise，超时返回 "timeout"（调用方负责真正中止子会话）。 */
export async function waitWithDeadline<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  /*
   * 不 unref：这个定时器就是「这次工具调用还活着」的唯一凭据。
   * unref 掉的话，事件循环没有别的句柄时会直接退出，超时永远不触发（测试里表现为
   * "Promise resolution is still pending but the event loop has already resolved"）。
   */
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // 超时之后那个 wait 还在飞：吞掉它后面可能的 rejection，别变成 unhandledRejection
    void promise.catch(() => undefined);
  }
}

/** 子会话 `pi.live` → 一行进度（第几轮、在跑什么工具）。 */
function summarizeLive(raw: unknown): string | null {
  const live = raw as
    | { run?: { turns?: number }; tools?: { name?: unknown; status?: unknown }[] }
    | undefined;
  if (!live) return null;
  const running = (live.tools ?? []).filter(
    (tool) => tool.status === "running" || tool.status === "pending",
  );
  const names = [...new Set(running.map((tool) => (typeof tool.name === "string" ? tool.name : "tool")))];
  const turns = typeof live.run?.turns === "number" ? `第 ${live.run.turns + 1} 轮 · ` : "";
  return names.length === 0 ? `${turns}正在生成` : `${turns}正在跑 ${names.join(" / ")}`;
}

/** `pi.usage` → token / 花费合计（子 agent 的钱记在它自己的会话里，父会话看不到）。 */
function usageTotals(raw: unknown): { tokens: number; cost: number } | null {
  const state = raw as
    | {
        models?: Record<string, { totalTokens?: unknown; cost?: { total?: unknown } }>;
        tools?: Record<string, { totalTokens?: unknown }>;
      }
    | undefined;
  if (!state) return null;
  let tokens = 0;
  let cost = 0;
  for (const bucket of [state.models, state.tools]) {
    for (const usage of Object.values(bucket ?? {})) {
      if (typeof usage?.totalTokens === "number") tokens += usage.totalTokens;
      const total = (usage as { cost?: { total?: unknown } } | undefined)?.cost?.total;
      if (typeof total === "number") cost += total;
    }
  }
  return tokens > 0 ? { tokens, cost } : null;
}

/**
 * 每个父会话最多同时跑几个子 agent。
 *
 * 为什么需要：pi-durable 的 `toolExecution` 默认是 parallel —— 模型一条消息里发 10 个
 * `subagent` 调用，就会同时开 10 个完整的模型循环（每个都背着整套工具 schema + 全局记忆）。
 * 没有上限的扇出，成本按个数直接乘。这里按「父会话」限流：超出的**排队**，不报错。
 */
const MAX_CONCURRENT_CHILDREN = 3;

/**
 * 一个父会话一个闸：正在跑的数量 + 排队的人。
 *
 * 语义：`release()` 把名额**转交**给队首，而不是"先减再加"——这样 running 永远不超上限，
 * 也不会出现"减到 0 被删掉、同时队列里还有人"的空窗。
 *
 * 进程内的，不需要持久化：它只是个限流器，崩溃重启后归零没有副作用。
 */
export class SubagentGate {
  #limit: number;
  #gates = new Map<number, { running: number; waiting: (() => void)[] }>();

  constructor(limit = MAX_CONCURRENT_CHILDREN) {
    this.#limit = limit;
  }

  /** 拿一个名额；满了就排队，前一个子 agent 结束才轮到。 */
  async acquire(parent: number): Promise<void> {
    const gate = this.#gateOf(parent);
    if (gate.running < this.#limit) {
      gate.running += 1;
      return;
    }
    await new Promise<void>((resolve) => gate.waiting.push(resolve));
  }

  /** 交还名额（或者直接转交给队首）。**必须**放在 finally 里，否则闸会越用越死。 */
  release(parent: number): void {
    const gate = this.#gates.get(parent);
    if (!gate) return;
    const next = gate.waiting.shift();
    if (next) {
      next(); // 名额转交：running 不变
      return;
    }
    gate.running -= 1;
    if (gate.running <= 0) this.#gates.delete(parent);
  }

  /** 测试/排查用：当前正在跑几个。 */
  running(parent: number): number {
    return this.#gates.get(parent)?.running ?? 0;
  }

  #gateOf(parent: number) {
    let gate = this.#gates.get(parent);
    if (!gate) {
      gate = { running: 0, waiting: [] };
      this.#gates.set(parent, gate);
    }
    return gate;
  }
}

/** AssistantMessage → 纯文本。content 可能是字符串，也可能是 block 数组。 */
function textOf(entry: { readonly model?: readonly unknown[] } | undefined): string {
  for (const message of entry?.model ?? []) {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      if (content.trim()) return content.trim();
      continue;
    }
    if (!Array.isArray(content)) continue;
    const parts: string[] = [];
    for (const block of content) {
      const b = block as { type?: string; text?: unknown };
      if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) parts.push(b.text);
    }
    if (parts.length > 0) return parts.join("\n");
  }
  return "";
}

/** 子 agent 的任务契约（字段和工具 schema 一一对应）。 */
interface SubagentArgs {
  goal: string;
  deliverable: string;
  materials?: string;
  acceptance?: string;
  constraints?: string;
}

/**
 * 把契约拼成一段有结构的 prompt。
 *
 * 为什么不用一句话：子 agent 看不到父的对话，也**不能反问**，任务必须自足 ——
 * 目标、材料在哪、交付什么、怎么算对、不能碰什么。
 * 反过来说，父在填字段的时候就被迫把这些想清楚了。
 */
function buildBrief(args: SubagentArgs): string {
  return [
    `# Goal\n${args.goal}`,
    args.materials === undefined
      ? undefined
      : `# Materials\nRead them yourself; do not wait for me to paste content: ${args.materials}`,
    `# Deliverable\n${args.deliverable}`,
    args.acceptance === undefined ? undefined : `# Acceptance\n${args.acceptance}`,
    args.constraints === undefined ? undefined : `# Constraints\n${args.constraints}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
}

export function subagentExtension(options: SubagentOptions) {
  /* 一个 agent 实例一个闸：模型同时发多个调用时，它们都落在同一个工具对象上。 */
  const gate = new SubagentGate();

  return defineExtension({
    name: "pii-subagent",
    tools: [
      defineTool({
        name: "subagent",
        description:
          "Delegate one self-contained task to a fresh child agent with its own context and a clean slate. " +
          "It does NOT see our conversation and CANNOT ask you follow-up questions, so the brief you write here " +
          "must stand on its own. Only its final answer comes back. " +
          "Prefer `materials` (paths it can read itself) over pasting content. " +
          "Use it for large reads, research, or independent work you can run in parallel.",
        parameters: obj({
          goal: str({ description: "The result to achieve, in one or two sentences." }),
          deliverable: str({
            description:
              "The exact shape of what comes back: a conclusion, a file path, a list, JSON with these keys... " +
              "The child returns only this, so say it precisely.",
          }),
          materials: opt(str({
            description:
              "Where the child gets the material itself: file paths, directories, or commands to run. " +
              "The child shares your working directory. Prefer this over pasting content.",
          })),
          acceptance: opt(str({ description: "How we will judge that it was done right." })),
          constraints: opt(str({
            description: "Rules it must follow and things it must not touch (read-only, no network, which branch...).",
          })),
          instructions: opt(str({ description: "Role/system instructions, e.g. 'review code read-only'." })),
          maxTurns: opt(num({ description: "Cap on the child's tool rounds. Optional but recommended for big jobs." })),
          readOnly: opt(bool({
            description:
              "Give the child only the `read` tool. Use it whenever it only needs to look, not change anything — " +
              "this is enforced, unlike asking it politely in `constraints`.",
          })),
          shareMemory: opt(bool({
            description:
              "Allow the child to WRITE the user's global memory (default false: it can read the memory section " +
              "but has no `memory` tool). The parent decides what becomes long-term memory.",
          })),
          timeoutMs: opt(num({
            description:
              "Hard deadline in milliseconds (default 300000, max 1800000). On timeout the child is aborted.",
          })),
        }),
        // 重跑是安全的：子会话 id 有 memo 兜底，投递有固定 requestId 兜底。
        replay: "safe",
        async execute(args, api, context) {
          const harness = options.getHarness();
          const caller = await api.agent(context);

          /* 1) 子会话：建一次，崩溃重跑时复用 memo 里那个（不要每跑一次就多开一间办公室）。 */
          let childId = await api.memo<number>(MEMO_KEY, context);
          if (childId === undefined) {
            /*
             * 子会话的工具集：注册表全量 − subagent 自己 −（可选）只留 read −（默认）去掉 memory 工具。
             *
             * 用 ToolRegistration 对象（不是名字）从 registry 快照里捞，这是 AgentChange.tools 的要求。
             * 为什么用注册表而不是父的 `agent.tools`：`api.agent()` 拿到的是解析后的工具，但我们不想让
             * 子会话继承父会话的临时过滤（那些是为「这一轮」算的）；这里要的是"这类子 agent 允许用什么"。
             */
            const allowlist = args.readOnly === true ? new Set(["read"]) : undefined;
            const childTools = api.registry
              .installed()
              .flatMap((extension) => extension.tools ?? [])
              .filter(
                (tool) =>
                  tool.name !== "subagent" &&
                  (allowlist === undefined || allowlist.has(tool.name)) &&
                  // 全局记忆默认只读：section 还在（它知道用户偏好），但写工具不给
                  (args.shareMemory === true || tool.name !== "memory"),
              );

            const child = await harness.createConversation(
              {
                ownership: { kind: "task", taskId: api.taskId },
                agent: {
                  model: caller.model ?? null,
                  cwd: caller.cwd ?? null,
                  instructions: args.instructions ?? null,
                  maxTurns:
                    args.maxTurns !== undefined && Number.isFinite(args.maxTurns) && args.maxTurns >= 1
                      ? Math.floor(args.maxTurns)
                      : null,
                  ...(childTools.length > 0 || args.readOnly === true ? { tools: childTools } : {}),
                },
              },
              context,
            );

            childId = Number(child.id);
            await api.memo(MEMO_KEY, childId, context);
          }

          /* 2) 投递任务。handle 是「调用期内有效」的句柄：调用结束就失效，但已投递的工作是持久的。 */
          const handle = await api.conversation(childId as ConversationId, context);
          if (!handle) {
            return {
              output: [{ type: "text", text: `子会话 ${childId} 打不开（可能已经被删了）。` }],
              isError: true,
              details: detailsOf({ conversationId: childId, error: "missing" }),
            };
          }

          /*
           * 3) 拿名额再投递：同一父会话最多同时跑 MAX_CONCURRENT_CHILDREN 个，多出来的在这里排队
           *    （不报错 —— 报错会让模型再发一遍，反而更贵）。
           *    排队期间这次运行被中止的话，submit 会失败，但 finally 一定把名额还回去。
           */
          const parent = Number(api.conversationId);
          await gate.acquire(parent);

          /*
           * 4) 盯住子会话的实时状态：父界面上的卡片至少能显示"它在第几轮跑什么"。
           *    进度写进 api.output()，它会进 live 的工具槽位（UI 只显示尾巴，不会进父的模型上下文）。
           */
          const childConversation = await harness.conversation(childId as ConversationId, context);
          const childView = childConversation ? await childConversation.watch(context) : undefined;
          let lastProgress = "";
          const emitProgress = (): void => {
            const line = summarizeLive(childView?.value.docs["pi.live"]);
            if (!line || line === lastProgress) return;
            lastProgress = line;
            api.output(`[子 agent #${childId}] ${line}\n`);
          };

          const timeoutMs = Math.min(
            MAX_TIMEOUT_MS,
            Math.max(
              MIN_TIMEOUT_MS,
              args.timeoutMs !== undefined && Number.isFinite(args.timeoutMs)
                ? Math.floor(args.timeoutMs)
                : DEFAULT_TIMEOUT_MS,
            ),
          );

          try {
            const submission = await handle.submit(
              {
                type: "input",
                content: buildBrief(args),
                // 同一次工具调用 → 同一个 requestId：重跑时拿回原 submission，不会问第二遍。
                requestId: `subagent:${api.callId}`,
              },
              context,
            );

            emitProgress();
            childView?.start(async (call) => {
              if (call.kind === "value") emitProgress();
            });

            /*
             * 5) 等它跑完，最多 timeoutMs。
             *    超时不是"不等了"，是真的把子会话停掉 —— 否则它会一直占着名额烧 token。
             */
            const receipt = await waitWithDeadline(submission.wait(context), timeoutMs);

            if (receipt === "timeout") {
              await handle.abort(context).catch(() => undefined);
              return {
                output: [
                  {
                    type: "text",
                    text: `子 agent 超时（${Math.round(timeoutMs / 1000)} 秒），已中止。子会话 #${childId}。`,
                  },
                ],
                isError: true,
                details: detailsOf({ conversationId: childId, timedOut: true }),
              };
            }

            if (receipt.status !== "done") {
              const detail =
                receipt.detail === undefined ? "" : ` · ${JSON.stringify(receipt.detail).slice(0, 200)}`;
              return {
                output: [
                  {
                    type: "text",
                    text: `子 agent 没有给出答案（${receipt.status}：${receipt.reason}${detail}）。子会话 #${childId}。`,
                  },
                ],
                isError: true,
                details: detailsOf({ conversationId: childId, error: receipt.reason }),
              };
            }

            /* 6) 读答案 + 用量：receipt.answer 就是最终 assistant entry 的 id。 */
            const answer = receipt.answer;
            if (answer === undefined) {
              return {
                output: [{ type: "text", text: "子 agent 的这次提交没有 answer（可能被中断了）。" }],
                isError: true,
                details: detailsOf({ conversationId: childId, error: "no-answer" }),
              };
            }
            const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), context);
            const text = textOf(entry);

            /* 用量记在子会话自己的 pi.usage 里（父会话看不到），顺手读出来给界面 */
            const usage = usageTotals(childView?.value.docs["pi.usage"]);
            return {
              output: [{ type: "text", text: text || "(子 agent 没有输出文本)" }],
              details: detailsOf({ conversationId: childId, ...(usage ?? {}) }),
            };
          } finally {
            try {
              await childView?.stop();
            } catch {
              /* 会话可能已经结束/关闭，停不下就算了 */
            }
            gate.release(parent);
          }
        },
      }),
    ],
  });
}
