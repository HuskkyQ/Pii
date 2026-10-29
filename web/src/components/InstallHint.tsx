import { Share, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

const DISMISS_KEY = "pii:install-hint-dismissed";

function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
  const webkit = /WebKit/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  return iOS && webkit;
}

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/**
 * iOS 的安装提示。
 *
 * iOS Safari 不触发 `beforeinstallprompt`，也没有安装按钮 ——
 * 用户必须自己「分享 → 添加到主屏幕」。所以在 iOS 上给一句提示。
 *
 * 只在 iOS Safari、非 standalone、且没被手动关过时显示。
 */
export function InstallHint() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (isStandalone() || !isIosSafari()) return;
    if (localStorage.getItem(DISMISS_KEY) === "1") return;
    setVisible(true);
  }, []);

  if (!visible) return null;

  return (
    <div className="mx-auto w-full max-w-[860px] px-3 pb-2 sm:px-4">
      <div className="flex items-start gap-2 rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-[12px] text-muted-foreground">
        <Share className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <p className="flex-1">
          点 Safari 的<strong className="text-foreground">分享</strong>，再选
          <strong className="text-foreground">添加到主屏幕</strong> —— 之后就能像 App 一样全屏打开。
        </p>
        <Button
          size="icon"
          variant="ghost"
          className="-mr-1 -mt-1 size-6 shrink-0"
          aria-label="不再提示"
          onClick={() => {
            localStorage.setItem(DISMISS_KEY, "1");
            setVisible(false);
          }}
        >
          <X className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
