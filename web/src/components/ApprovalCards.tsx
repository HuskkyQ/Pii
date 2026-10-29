import { Check, ShieldAlert, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import type { ApprovalRequest } from "@/lib/types";

interface ApprovalCardsProps {
  approvals: ApprovalRequest[];
  onDecide: (id: string, allow: boolean) => void;
}

/** 审批卡片：停在输入框上方，带倒计时；超时服务端会自动拒绝。 */
export function ApprovalCards({ approvals, onDecide }: ApprovalCardsProps) {
  const [, tick] = useState(0);

  useEffect(() => {
    if (approvals.length === 0) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [approvals.length]);

  if (approvals.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-full z-10 mb-2 space-y-2 px-4">
      {approvals.map((request) => (
        <div
          key={request.id}
          className="pointer-events-auto mx-auto w-full max-w-[860px] rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 shadow-lg backdrop-blur"
        >
          <div className="flex items-center gap-2 text-[12px] font-medium text-amber-300">
            <ShieldAlert className="size-4" aria-hidden />
            agent 想调用工具 · <code className="font-mono">{request.tool}</code>
            <span className="ml-auto font-normal text-muted-foreground">
              {Math.max(0, Math.round((request.expiresAt - Date.now()) / 1000))} 秒后自动拒绝
            </span>
          </div>
          <pre className="mt-2 max-h-[26vh] overflow-auto rounded-md border border-amber-500/20 bg-background/60 p-2.5 font-mono text-[12px] leading-relaxed">
            {JSON.stringify(request.input, null, 2)}
          </pre>
          <div className="mt-2.5 flex items-center gap-2">
            <Button size="sm" onClick={() => onDecide(request.id, true)}>
              <Check className="mr-1 size-3.5" aria-hidden />
              允许
            </Button>
            <Button size="sm" variant="destructive" onClick={() => onDecide(request.id, false)}>
              <X className="mr-1 size-3.5" aria-hidden />
              拒绝
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
