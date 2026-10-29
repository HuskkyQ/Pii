/**
 * 审批中转站：agent 要跑工具时挂在这里，等浏览器点头。
 *
 * 为什么需要它：pi-durable 的 `beforeTool` hook 可以返回 Promise，
 * 所以我们把「问用户」变成一个真实的 await，而不是「先拒绝再重问」。
 *
 * 生命周期：
 *   hook → request()  ← 挂起，推 SSE 给前端
 *   前端 POST /api/approve { id, allow } → settle()
 *   超时 / 服务关闭 → 一律拒绝（fail-closed）
 */
import { randomUUID } from "node:crypto";

export interface ApprovalRequest {
  id: string;
  /** 这个审批属于哪个会话。前端只显示当前会话的审批，避免串台。 */
  conversationId: number;
  /** 模型给的 tool call id */
  callId: string;
  tool: string;
  input: unknown;
  createdAt: number;
  /** 超时时刻（毫秒时间戳），前端可用来倒计时 */
  expiresAt: number;
}

export type ApprovalOutcome = {
  id: string;
  allow: boolean;
  reason: "user" | "timeout" | "shutdown";
};

interface Pending {
  request: ApprovalRequest;
  resolve: (outcome: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ApprovalBrokerOptions {
  timeoutMs?: number;
  /** 这些工具不问，直接放行。默认只有只读的 read。（仅在没提供 shouldAutoAllow 时作全局回退） */
  autoAllow?: readonly string[];
  /**
   * 按「会话 + 工具」动态判定是否自动放行。传了它就用它，
   * 覆盖上面的全局 autoAllow —— 这是「按会话配置审批策略」的挂接点。
   */
  shouldAutoAllow?: (conversationId: number, tool: string) => boolean;
}

export class ApprovalBroker {
  #pending = new Map<string, Pending>();
  #requestListeners = new Set<(request: ApprovalRequest) => void>();
  #outcomeListeners = new Set<(outcome: ApprovalOutcome) => void>();
  readonly timeoutMs: number;
  readonly autoAllow: ReadonlySet<string>;
  #shouldAutoAllow?: (conversationId: number, tool: string) => boolean;

  constructor(options: ApprovalBrokerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.#shouldAutoAllow = options.shouldAutoAllow;
    this.autoAllow = new Set(
      options.autoAllow ?? (process.env.PII_AUTO_ALLOW ?? "read").split(",").map((s) => s.trim()),
    );
  }

  /** 当前挂起的审批（重连时补发用）。传 conversationId 只看那一个会话的。 */
  list(conversationId?: number): ApprovalRequest[] {
    const all = [...this.#pending.values()].map((p) => p.request);
    return conversationId === undefined ? all : all.filter((r) => r.conversationId === conversationId);
  }

  /** hook 调用这个：挂起，直到前端回答或超时。 */
  request(input: {
    conversationId: number;
    callId: string;
    tool: string;
    input: unknown;
  }): Promise<ApprovalOutcome> {
    if (this.#shouldAutoAllow ? this.#shouldAutoAllow(input.conversationId, input.tool) : this.autoAllow.has(input.tool)) {
      return Promise.resolve({ id: "auto", allow: true, reason: "user" });
    }

    const now = Date.now();
    const request: ApprovalRequest = {
      id: randomUUID(),
      conversationId: input.conversationId,
      callId: input.callId,
      tool: input.tool,
      input: input.input,
      createdAt: now,
      expiresAt: now + this.timeoutMs,
    };

    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.#settle(request.id, { id: request.id, allow: false, reason: "timeout" });
      }, this.timeoutMs);
      // 别让挂起的审批把进程钉住
      timer.unref?.();

      this.#pending.set(request.id, { request, resolve, timer });
      for (const listener of this.#requestListeners) {
        try {
          listener(request);
        } catch {
          /* 监听器出错不影响审批本身 */
        }
      }
    });
  }

  /** 前端回答。返回 false 表示这个 id 已经不存在（超时或已答过）。 */
  settle(id: string, allow: boolean): boolean {
    return this.#settle(id, { id, allow, reason: "user" });
  }

  #settle(id: string, outcome: ApprovalOutcome): boolean {
    const pending = this.#pending.get(id);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.#pending.delete(id);
    pending.resolve(outcome);
    for (const listener of this.#outcomeListeners) {
      try {
        listener(outcome);
      } catch {
        /* ignore */
      }
    }
    return true;
  }

  /** 关服务时把所有挂起的都拒掉。 */
  dispose(): void {
    for (const [id] of [...this.#pending]) {
      this.#settle(id, { id, allow: false, reason: "shutdown" });
    }
  }

  onRequest(listener: (request: ApprovalRequest) => void): () => void {
    this.#requestListeners.add(listener);
    return () => this.#requestListeners.delete(listener);
  }

  onOutcome(listener: (outcome: ApprovalOutcome) => void): () => void {
    this.#outcomeListeners.add(listener);
    return () => this.#outcomeListeners.delete(listener);
  }
}
