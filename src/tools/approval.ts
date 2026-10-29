/**
 * 把审批中转站接到 pi-durable 的 `beforeTool` hook 上。
 *
 * `beforeTool` 允许返回 Promise —— 这是「阻塞式审批」能成立的关键：
 * 工具任务真的会停在原地等你点「允许」，而不是先被拒绝再让模型重试。
 */
import { ToolTask, defineExtension, hook } from "@earendil-works/pi-durable";

import type { ApprovalBroker } from "../server/approvals.ts";

export function approvalExtension(broker: ApprovalBroker) {
  return defineExtension({
    name: "pii-approval",
    hooks: [
      hook(ToolTask, {
        async beforeTool(call, api, context) {
          const outcome = await broker.request({
            conversationId: Number(api.conversationId),
            callId: call.id,
            tool: call.name,
            input: call.arguments,
          });

          if (outcome.allow) return undefined;

          const why =
            outcome.reason === "timeout"
              ? "审批超时（120 秒内没有回应），已拒绝"
              : outcome.reason === "shutdown"
                ? "服务正在关闭，已拒绝"
                : "用户拒绝了这个操作";

          return { block: why };
        },
      }),
    ],
  });
}
