/**
 * 进程锁：一个数据目录只允许一个 pii 进程持有（SQLite 单写者）。
 *
 * 锁文件里存 `主机名:pid`，不只是一个 pid。为什么：
 *   容器被 `docker rm -f` 杀掉时不会走优雅退出，锁文件留在数据目录里。
 *   下次启动如果只看 pid，就可能撞上「新容器里恰好也有个同号进程」，
 *   于是永远启动不了（crash loop）。加上主机名之后：
 *     - 主机名不同 → 上一代容器的残留，直接覆盖
 *     - 主机名相同且进程还在 → 真的重复启动，拒绝
 *
 * 从 `context.ts` 原样搬出（逻辑一字未改），只是变成可单独测试的模块。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export function acquireLock(dir: string): () => void {
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, "server.lock");
  const identity = `${hostname()}:${process.pid}`;

  try {
    const raw = readFileSync(lockPath, "utf8").trim();
    // 兼容老格式（纯 pid）
    const [maybeHost, maybePid] = raw.includes(":") ? raw.split(":") : [undefined, raw];
    const existingHost = maybeHost;
    const existingPid = Number(maybePid);

    const sameHost = existingHost === undefined ? true : existingHost === hostname();
    if (sameHost && existingPid && existingPid !== process.pid) {
      try {
        process.kill(existingPid, 0);
        throw new Error(`已经有 pii 在跑（pid ${existingPid}），数据目录 ${dir}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  writeFileSync(lockPath, identity);
  return () => rmSync(lockPath, { force: true });
}
