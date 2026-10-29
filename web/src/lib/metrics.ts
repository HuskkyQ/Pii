/**
 * 把真机的尺寸上报给服务端。
 *
 * 为什么需要这个：布局问题（安全区、视口高度、键盘）在 headless 里量不到 ——
 * headless 没有刘海，`env(safe-area-inset-*)` 全是 0。所以让页面自己报，
 * 服务端 `GET /api/client-metrics` 就能看到，不用靠截图猜。
 *
 * 顺带上报 `BUILD`（vite 注入的构建时间戳）：
 * 这是区分「改了没生效」和「手机上跑的还是旧缓存」的唯一可靠办法。
 */
import { getApiTimings } from "./api";

declare const __BUILD__: string;

interface Rect {
  top: number;
  bottom: number;
  height: number;
}

function rectOf(selector: string): Rect | null {
  const element = document.querySelector(selector);
  const box = element?.getBoundingClientRect();
  return box ? { top: Math.round(box.top), bottom: Math.round(box.bottom), height: Math.round(box.height) } : null;
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

/**
 * 量一下各种「视口高度单位」到底等于多少像素。
 *
 * 为什么需要：你机器上 innerHeight = 873，但屏幕是 932 —— 差的 59px
 * 正好是状态栏高度。也就是说这个 webview 的布局视口比屏幕矮了一截，
 * 底部那 59px 谁也不属于（body 盖不到），所以看起来是“一大块空白”。
 * 到底哪个单位能拿到 932，只有真机量了才知道。
 */
function readViewportUnits(): Record<string, number> {
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;top:0;left:0;width:0;visibility:hidden;pointer-events:none;";
  document.body.appendChild(probe);
  const read = (height: string) => {
    probe.style.height = height;
    return Math.round(probe.getBoundingClientRect().height);
  };
  const units: Record<string, number> = {
    vh: read("100vh"),
    dvh: read("100dvh"),
    svh: read("100svh"),
    lvh: read("100lvh"),
    pct: read("100%"),
    screenH: window.screen.height,
    // screen.availHeight = 系统认为「可用」的高度（已扣掉状态栏等）
    // 如果它 == innerHeight，说明视口本来就落在状态栏下方，不需要再补内边距
    availH: window.screen.availHeight,
  };
  probe.remove();
  return units;
}

export function reportClientMetrics(): void {
  const safe = readSafeInsets();
  const visual = window.visualViewport;

  const payload = {
    build: typeof __BUILD__ === "string" ? __BUILD__ : "dev",
    inner: [window.innerWidth, window.innerHeight],
    visual: visual ? [Math.round(visual.width), Math.round(visual.height), Math.round(visual.offsetTop)] : null,
    doc: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
    scrollY: Math.round(window.scrollY),
    safeTop: safe.top,
    safeBottom: safe.bottom,
    standalone:
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true,
    dpr: window.devicePixelRatio,
    /** 分段计时：哪个请求慢、骨架要多久 */
    timings: getApiTimings(),
    /** 导航分段：HTML 到得多快、DOM 就绪多久（区分“网络握手”和“应用逻辑”） */
    nav: (() => {
      const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      if (!entry) return null;
      return {
        // 连接建立（复用连接时为 0）
        connect: Math.round(entry.connectEnd - entry.connectStart),
        tls: Math.round(entry.secureConnectionStart > 0 ? entry.connectEnd - entry.secureConnectionStart : 0),
        // 请求发出到首字节：最能反映链路 RTT 的数字
        ttfb: Math.round(entry.responseStart - entry.requestStart),
        html: Math.round(entry.responseEnd - entry.responseStart),
        domReady: Math.round(entry.domContentLoadedEventEnd),
        fromSW: entry.workerStart > 0,
      };
    })(),
    units: readViewportUnits(),
    header: rectOf("header"),
    composer: rectOf("textarea"),
    list: rectOf("[data-radix-scroll-area-viewport]"),
    // 会话恢复诊断：冷启动时 URL / localStorage 里到底有没有值
    search: window.location.search,
    stored: (() => {
      try {
        return localStorage.getItem("pii:last-conversation");
      } catch {
        return "ERR";
      }
    })(),
  };

  void fetch("/api/client-metrics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {
    /* 上报失败不能影响使用 */
  });
}

/** 启动时上报一次，视口变化（转屏 / 键盘 / 拖动）再补报。 */
export function installMetricsReporting(): void {
  // 首帧上报要等 React 渲染完，否则 header/composer 还是 null
  setTimeout(() => void reportClientMetrics(), 500);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void reportClientMetrics(), 600);
  };
  window.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("scroll", schedule);
}
