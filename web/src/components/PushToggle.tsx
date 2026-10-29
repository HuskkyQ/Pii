import { Bell, BellOff, BellRing, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { disablePush, enablePush, readPushState, type PushState } from "@/lib/push";

const HINT: Record<PushState, string> = {
  unsupported: "这个环境不支持推送（需要 https 或 localhost，且是生产构建）",
  denied: "通知权限被浏览器拒绝了，要在站点设置里改回来",
  ready: "开启通知：跑完 / 需要审批时提醒你",
  subscribed: "通知已开启，点一下关闭",
};

/** 状态栏上那个小铃铛：开关推送。 */
export function PushToggle({ conversationId }: { conversationId?: number }) {
  const [state, setState] = useState<PushState>("unsupported");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void readPushState().then(setState);
  }, []);

  const toggle = useCallback(async () => {
    if (busy || state === "unsupported" || state === "denied") return;
    setBusy(true);
    try {
      if (state === "subscribed") {
        await disablePush();
        setState("ready");
        toast.success("已关闭通知");
      } else {
        await enablePush(conversationId);
        setState("subscribed");
        toast.success("已开启通知");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      setState(await readPushState());
    } finally {
      setBusy(false);
    }
  }, [busy, conversationId, state]);

  const Icon = busy ? Loader2 : state === "subscribed" ? BellRing : state === "denied" ? BellOff : Bell;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="size-8 shrink-0"
          onClick={() => void toggle()}
          disabled={busy || state === "unsupported" || state === "denied"}
          aria-label={HINT[state]}
          aria-pressed={state === "subscribed"}
        >
          <Icon className={busy ? "size-4 animate-spin" : "size-4"} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{HINT[state]}</TooltipContent>
    </Tooltip>
  );
}
