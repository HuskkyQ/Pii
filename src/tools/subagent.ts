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
 * 五条纪律：
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
 */
import {
  AssistantEntry,
  defineExtension,
  defineTool,
  type ConversationId,
  type Harness,
} from "@earendil-works/pi-durable";
import { num, obj, opt, str } from "@earendil-works/pi-schema";

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
             * 子会话的工具集 = 父会话的工具集 - subagent 自己。
             * 用 ToolRegistration 对象（不是名字）从 registry 快照里捞，这是 AgentChange.tools 的要求。
             */
            const childTools = api.registry
              .installed()
              .flatMap((extension) => extension.tools ?? [])
              .filter((tool) => tool.name !== "subagent");

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
                  ...(childTools.length > 0 ? { tools: childTools } : {}),
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
            };
          }

          /*
           * 3) 拿名额再投递：同一父会话最多同时跑 MAX_CONCURRENT_CHILDREN 个，多出来的在这里排队
           *    （不报错 —— 报错会让模型再发一遍，反而更贵）。
           *    排队期间这次运行被中止的话，submit 会失败，但 finally 一定把名额还回去。
           */
          const parent = Number(api.conversationId);
          await gate.acquire(parent);
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

            /* 4) 等它跑完。注意：取消 context 只停止「等待」，子会话会继续跑完。 */
            const receipt = await submission.wait(context);

            if (receipt.status !== "done") {
              return {
                output: [
                  {
                    type: "text",
                    text: `子 agent 没有给出答案（${receipt.status}：${receipt.reason}）。`,
                  },
                ],
                isError: true,
              };
            }

            /* 5) 读答案：receipt.answer 就是最终 assistant entry 的 id。 */
            const answer = receipt.answer;
            if (answer === undefined) {
              return {
                output: [{ type: "text", text: "子 agent 的这次提交没有 answer（可能被中断了）。" }],
                isError: true,
              };
            }
            const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), context);
            const text = textOf(entry);

            return {
              output: [{ type: "text", text: text || "(子 agent 没有输出文本)" }],
              details: { conversationId: childId },
            };
          } finally {
            gate.release(parent);
          }
        },
      }),
    ],
  });
}
