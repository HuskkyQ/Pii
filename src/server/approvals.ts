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

import { loadConfig } from "../config.ts";

/* 审批的「出口类型」在 ports.ts（agent 层），实现留在本文件；request() 是对接点。 */
import type { ApprovalOutcome, ApprovalPort } from "../ports.ts";
export type { ApprovalOutcome };

/* 形状住在 shared/types.ts（前端渲染审批卡也用同一份）。 */
import type { ApprovalRequest } from "../../shared/types.ts";
export type { ApprovalRequest };

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
  /**
   * 把发起方会话映射成「用户看得见的那个会话」。
   *
   * 子 agent 的会话是任务所有（`record.owner`），父界面的 SSE 只收当前会话的审批，
   * 如果按子会话 id 记，卡片推给谁都不知道，120 秒后按拒绝处理 —— 子 agent 就那么卡死。
   * 映射到父会话后：卡片弹在用户正在看的界面上，策略也按父会话算。
   */
  resolveConversation?: (conversationId: number) => number | Promise<number>;
}

export class ApprovalBroker implements ApprovalPort {
  #pending = new Map<string, Pending>();
  #requestListeners = new Set<(request: ApprovalRequest) => void>();
  #outcomeListeners = new Set<(outcome: ApprovalOutcome) => void>();
  readonly timeoutMs: number;
  readonly autoAllow: ReadonlySet<string>;
  #shouldAutoAllow?: (conversationId: number, tool: string) => boolean;
  #resolveConversation?: (conversationId: number) => number | Promise<number>;

  constructor(options: ApprovalBrokerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.#shouldAutoAllow = options.shouldAutoAllow;
    this.#resolveConversation = options.resolveConversation;
    /* `?? "read"` 这层回退留在调用点：和 policies.ts 的 DEFAULT_PRESET 不是同一回事。 */
    this.autoAllow = new Set(
      options.autoAllow ?? (loadConfig().autoAllowEnv ?? "read").split(",").map((s) => s.trim()),
    );
  }

  /** 当前挂起的审批（重连时补发用）。传 conversationId 只看那一个会话的。 */
  list(conversationId?: number): ApprovalRequest[] {
    const all = [...this.#pending.values()].map((p) => p.request);
    return conversationId === undefined ? all : all.filter((r) => r.conversationId === conversationId);
  }

  /** hook 调用这个：挂起，直到前端回答或超时。 */
  async request(input: {
    conversationId: number;
    callId: string;
    tool: string;
    input: unknown;
  }): Promise<ApprovalOutcome> {
    /*
     * 先把「谁在申请」映射成「用户看得见谁」：子 agent 的会话映射到它的父会话。
     * 一步到位 —— 后面的策略判断、挂起、推送、SSE 补发全都用这一个 id。
     */
    const conversationId = this.#resolveConversation
      ? await this.#resolveConversation(input.conversationId)
      : input.conversationId;

    if (this.#shouldAutoAllow ? this.#shouldAutoAllow(conversationId, input.tool) : this.autoAllow.has(input.tool)) {
      return { id: "auto", allow: true, reason: "user" };
    }

    const now = Date.now();
    const request: ApprovalRequest = {
      id: randomUUID(),
      conversationId,
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
