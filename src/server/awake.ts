/**
 * 让 Mac 别睡着。
 *
 * 为什么需要：锁屏不影响 node（进程照跑），但**系统空闲睡眠会**——
 * 一睡着，SSE 断、Tailscale 断、手机就连不上了，推送也发不出去。
 *
 * 做法：起一个 `caffeinate` 子进程，用 `-w <pid>` 绑在服务进程上。
 * 服务活着它就活着，服务退出它自动退 —— 不会留下「忘了关」的唤醒锁。
 *
 * 只影响「空闲睡眠」：
 *   - 锁屏、关显示器     → 依然能跑 ✅
 *   - 合上盖子           → 仍然会睡（除非接电源 + 外接显示器，这是 macOS 的策略）
 *
 * 关掉它：PII_KEEP_AWAKE=0
 */
import { spawn } from "node:child_process";

export interface AwakeHandle {
  active: boolean;
  stop: () => void;
}

export function keepAwake(): AwakeHandle {
  const disabled = process.env.PII_KEEP_AWAKE === "0";
  if (process.platform !== "darwin" || disabled) {
    return { active: false, stop: () => {} };
  }

  try {
    // -i 阻止空闲睡眠；-s 接着电源时阻止系统睡眠；-w 等这个 pid 退出后自己退
    const child = spawn("caffeinate", ["-i", "-s", "-w", String(process.pid)], {
      stdio: "ignore",
    });
    child.unref();

    return {
      active: true,
      stop: () => {
        try {
          child.kill();
        } catch {
          /* 已经退了 */
        }
      },
    };
  } catch (error) {
    console.warn(`  保持唤醒失败：${(error as Error).message}（继续运行，只是可能被睡眠中断）`);
    return { active: false, stop: () => {} };
  }
}
