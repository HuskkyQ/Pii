/**
 * agent 扩展所需的**窄端口**。
 *
 * 问题：`src/tools/*.ts`（pi-durable 扩展）和 `src/agent.ts` 原来这样写：
 *
 *     import type { ApprovalBroker } from "../server/approvals.ts";   // ← 整个 HTTP 模块
 *     import type { PushHub }        from "../server/push.ts";
 *
 * 它们真正要的只是「问一句要不要放行」「推一条通知」两个方法，
 * 却把整个 HTTP 服务层的类型拖了进来。后果很实在：
 *  - 想单独跑一个不带 web 的 agent（`src/stage0.ts` 那种用法）就难了；
 *  - 依赖图变糊，改 server/ 里的任何东西都像是「可能影响 agent」。
 *
 * 做法：**接口在这里，实现还在 `src/server/`**。
 *
 *     src/tools/approval.ts ─┐
 *     src/tools/notify.ts  ─┼─→ src/ports.ts ←── src/server/approvals.ts（implements）
 *     src/agent.ts         ─┘                ←── src/server/push.ts      （implements）
 *
 * 依赖方向只有「实现 → 端口」，端口一个 import 都没有。
 *
 * 注意：**不要**把 `ApprovalBroker` / `PushHub` 整个搬过来。
 * 它们读写 `vapid.json`、订阅表、SSE 结算、120 秒超时 —— 那些都是 HTTP 服务的事，
 * `routes/run.ts`、`routes/meta.ts`、`context.ts` 也还在用它们的方法。
 */

/** 一次审批的结局：`user` = 用户点了，`timeout` / `shutdown` = 兜底拒绝（fail-closed）。 */
export type ApprovalOutcome = {
  id: string;
  allow: boolean;
  reason: "user" | "timeout" | "shutdown";
};

/** 审批端口：扩展只调 `request()`，等一个结局。 */
export interface ApprovalPort {
  request(input: {
    conversationId: number;
    callId: string;
    tool: string;
    input: unknown;
  }): Promise<ApprovalOutcome>;
}

export interface PushPayload {
  title: string;
  body: string;
  conversationId?: number;
  /** 同一个 tag 的新通知会替换旧的（别让一条会话刷出 10 条） */
  tag?: string;
}

/** 推送端口：扩展只管把内容交出去，发不发、发给谁由实现决定。 */
export interface PushPort {
  notify(payload: PushPayload): void | Promise<unknown>;
}
