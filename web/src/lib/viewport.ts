/**
 * 顶部安全区到底是「该补」还是「系统已经让开了」，只能实测。
 *
 * 两种机型的现实：
 *   A) 视口盖住状态栏 → innerHeight ≈ 屏幕高，需要自己补 env(safe-area-inset-top)
 *   B) 视口已经在状态栏下方 → innerHeight ≈ 屏幕高 - 状态栏高，再补就多出一条空白
 *
 * 判据：`屏幕高 - 视口高` 是否约等于 statusBar 高。
 * 相等 → 已经让开了（B）→ 补 0；否则（A）→ 补真实安全区。
 *
 * 写成 CSS 变量而不是直接改 DOM 样式，让布局仍然可以在 CSS 里表达。
 */
function safeInsetTop(): number {
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;visibility:hidden;padding-top:env(safe-area-inset-top);";
  document.body.appendChild(probe);
  const value = Number.parseFloat(getComputedStyle(probe).paddingTop) || 0;
  probe.remove();
  return value;
}

function apply(): void {
  const inset = safeInsetTop();
  const screenHeight = window.screen.height;
  const viewportHeight = window.innerHeight;

  // 容差 2px：不同 iOS 版本会有 1px 的取整差异
  const alreadyInset = inset > 0 && Math.abs(screenHeight - viewportHeight - inset) <= 2;

  document.documentElement.style.setProperty("--app-pt", alreadyInset ? "0px" : `${inset}px`);
}

export function installViewportFix(): void {
  apply();
  window.addEventListener("resize", apply);
  window.addEventListener("orientationchange", apply);
  window.visualViewport?.addEventListener("resize", apply);
}
