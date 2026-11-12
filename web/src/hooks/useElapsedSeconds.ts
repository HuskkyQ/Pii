import { useEffect, useRef, useState } from "react";

/**
 * 「当前状态已经持续了多少秒」。
 *
 * 只在 `active` 为真时计时；`resetKey` 变化（例如从思考切到执行工具）会归零。
 * 从 LiveRow 抽出来，是因为现在「过程轨道」和「流式正文」都要用它。
 */
export function useElapsedSeconds(active: boolean, resetKey: string): number {
  const [seconds, setSeconds] = useState(0);
  const startedAt = useRef(0);

  useEffect(() => {
    if (!active) return;
    startedAt.current = Date.now();
    setSeconds(0);
    const timer = setInterval(() => {
      setSeconds(Math.floor((Date.now() - startedAt.current) / 1000));
    }, 250);
    return () => clearInterval(timer);
  }, [active, resetKey]);

  return seconds;
}
