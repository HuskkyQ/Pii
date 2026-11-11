/**
 * 退出登录（只在服务端开了鉴权时出现，且只在桌面显示）。
 *
 * 三件事值得解释：
 *
 * ① 为什么由服务端回答「要不要显示」
 *    cookie 是 HttpOnly，前端看不到它；而「开没开鉴权」只有服务端知道。
 *    问一句 `/api/auth` 比让按钮永远显示、点了 404 强。
 *
 * ② 为什么要两段式确认
 *    会话删除用的是同一套（点一下变「确认删除？」）。退出本身不可怕，但在
 *    令牌登录的环境里，令牌躺在服务器的文件里 —— 登出了未必马上回得来，
 *    所以别让误触一键结束。
 *
 * ③ 为什么只给桌面
 *    手机上状态栏本来就挤（标题 / 连接状态 / 铃铛），退出登录不是高频动作；
 *    真要在手机上也放出来，把 className 里的 `hidden md:inline-flex` 去掉即可。
 */
import { LogOut, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getAuthInfo, logout } from "@/lib/api";

/** 确认态自动收回的时间：够点第二下，又不至于一直挂着等人误触。 */
const CONFIRM_MS = 4000;

export function LogoutButton() {
  /** null = 还不知道（还没问到服务端），这时什么都不画，避免闪一下又消失 */
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getAuthInfo()
      .then((info) => setEnabled(info.enabled))
      // 问不到就当没开：宁可不显示，也不要给一个点了就 404 的按钮
      .catch(() => setEnabled(false));
  }, []);

  // 进入确认态后 4 秒自动收回：够点第二下，又不至于一直挂着等人误触。
  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), CONFIRM_MS);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  if (!enabled) return null;

  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await logout();
      // 成功后页面就要跳走了，这里不用再 setBusy(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "退出失败");
      setBusy(false);
      setConfirming(false);
    }
  };

  if (confirming) {
    return (
      <Button
        size="sm"
        variant="ghost"
        className="hidden h-7 shrink-0 px-2 text-[12px] text-destructive hover:bg-destructive/15 hover:text-destructive md:inline-flex"
        onClick={() => void run()}
        disabled={busy}
        aria-label="确认退出登录"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : "退出？"}
      </Button>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="hidden size-8 shrink-0 md:inline-flex"
          onClick={() => setConfirming(true)}
          aria-label="退出登录"
        >
          <LogOut className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">退出登录（清掉这个浏览器的登录 cookie）</TooltipContent>
    </Tooltip>
  );
}
