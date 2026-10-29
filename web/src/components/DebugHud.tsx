/**
 * 真机才量得到的数字：浏览器里 `env(safe-area-inset-*)` 是 0，
 * headless 里更是一个都没有。所以留一个 `?debug=1` 的自检面板，
 * 让手机上把「布局视口 / 视觉视口 / 安全区」直接贴出来。
 *
 * 只在 URL 带 `debug=1` 时渲染，正常使用看不见。
 */
import { useEffect, useState } from "react";

interface Metrics {
  inner: string;
  visual: string;
  root: string;
  body: string;
  safeTop: string;
  safeBottom: string;
  standalone: string;
  dpr: number;
}

function readSafeInsets(): { top: string; bottom: string } {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;visibility:hidden;pointer-events:none;" +
    "padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);";
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const value = { top: style.paddingTop, bottom: style.paddingBottom };
  probe.remove();
  return value;
}

function measure(): Metrics {
  const root = document.getElementById("root")?.firstElementChild;
  const visual = window.visualViewport;
  const safe = readSafeInsets();
  return {
    inner: `${window.innerWidth}×${window.innerHeight}`,
    visual: visual ? `${Math.round(visual.width)}×${Math.round(visual.height)}` : "n/a",
    root: root ? `${Math.round(root.getBoundingClientRect().width)}×${Math.round(root.getBoundingClientRect().height)}` : "n/a",
    body: `${document.documentElement.scrollWidth}×${document.documentElement.scrollHeight}`,
    safeTop: safe.top,
    safeBottom: safe.bottom,
    standalone: String(
      window.matchMedia("(display-mode: standalone)").matches ||
        (navigator as Navigator & { standalone?: boolean }).standalone === true,
    ),
    dpr: window.devicePixelRatio,
  };
}

export function DebugHud() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("debug") !== "1") return;
    const update = () => setMetrics(measure());
    update();
    const timer = setInterval(update, 1000);
    window.visualViewport?.addEventListener("resize", update);
    return () => {
      clearInterval(timer);
      window.visualViewport?.removeEventListener("resize", update);
    };
  }, []);

  if (!metrics) return null;

  const rows: [string, string][] = [
    ["innerWH", metrics.inner],
    ["visualWH", metrics.visual],
    ["rootWH", metrics.root],
    ["docWH", metrics.body],
    ["safeTop", metrics.safeTop],
    ["safeBottom", metrics.safeBottom],
    ["standalone", metrics.standalone],
    ["dpr", String(metrics.dpr)],
  ];

  return (
    <div className="fixed inset-x-0 top-0 z-[9999] border-b border-amber-500/40 bg-black/95 px-2 py-1.5 font-mono text-[10px] leading-[1.5] text-amber-200">
      <div className="grid grid-cols-2 gap-x-3">
        {rows.map(([key, value]) => (
          <div key={key} className="flex gap-1.5 truncate">
            <span className="shrink-0 opacity-55">{key}</span>
            <span className="truncate">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
