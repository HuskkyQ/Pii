/**
 * 原子写侧车文件（策略 / 标题 / 回收站 / 上次会话 / VAPID / 推送订阅 / 令牌 / 归档快照）。
 *
 * ── 为什么在 `src/` 根下，而不在 `src/server/` ──
 * 调用方横跨两层：`src/server/*`（策略、鉴权、推送）和 `src/archive.ts`（归档 .md）。
 * 放在 `src/server/` 会让 `src/archive.ts` 反向依赖 HTTP 层，破坏
 * 「`src/tools/*`、`src/*` 不能 import `src/server/*`」的分层约定（参见 archive.ts 里的同类说明）。
 * 这个模块只碰 `node:fs`，哪一层都能用。
 *
 * 为什么需要：这些文件以前都是 `writeFileSync(path, ...)` 直接覆盖目标文件。
 * 那条路径**不是原子的** —— 内核先把目标文件截断成 0 字节，再往里灌数据。
 * 进程在两者之间被 `docker stop` / OOM / `kill -9` 打死，磁盘上就留下半截 JSON。
 *
 * 坏掉的后果按文件不同，都不轻：
 *   - `conversation-policies.json` 坏 → 读失败返回 `{}`，所有会话**悄悄**退回默认策略
 *   - `vapid.json` 坏 → 重新生成密钥，**所有设备的推送订阅就地失效**
 *   - 标题 / 回收站 / 上次会话 → 数据直接丢
 *
 * 三步走，缺一不可：
 *   1. 写**同目录**的临时文件。必须同目录：跨文件系统的 rename 不是原子操作，
 *      会退化成「复制 + 删除」，中间照样能被打断。
 *   2. `fsync`。少了这步，rename 可能先于内容落盘，断电后得到一个
 *      「名字对、内容空」的文件 —— 比没写还糟。
 *   3. `rename` 覆盖。POSIX 保证这一步原子：读者要么看到旧文件、要么看到新文件，
 *      永远看不到写了一半的。
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/** 同一毫秒内对同一路径连写两次时，靠它把临时文件名区分开 */
let seq = 0;

/**
 * 目标文件当前的权限位；文件不存在时给 0644。
 *
 * 为什么要继承：`rename` 会把临时文件的**权限一起继承过去**。
 * 若调用方没显式传 mode，直接拿 0644 建临时文件，一次重写就会把
 * 原本 0600 的密钥文件悄悄放宽成 0644 —— 原子性修好了，权限却漏了。
 */
function resolveMode(path: string, explicit?: number): number {
  if (explicit !== undefined) return explicit;
  if (existsSync(path)) return statSync(path).mode & 0o777;
  return 0o644;
}

export function writeFileAtomic(path: string, content: string, options: { mode?: number } = {}): void {
  const mode = resolveMode(path, options.mode);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${seq++}.tmp`;

  let fd: number | undefined;
  try {
    // 临时文件就按目标权限建（0600 的文件不能在落地瞬间变成 0644）
    fd = openSync(tmp, "w", mode);
    writeSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 关不掉就算了，下面还要删临时文件，不能因为这里再抛一个异常盖掉原始错误
      }
    }
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** 原子写 JSON。落盘格式（两空格缩进、无尾随换行）和原来的 `writeFileSync` 保持一致。 */
export function writeJsonAtomic(path: string, value: unknown, options: { mode?: number } = {}): void {
  writeFileAtomic(path, JSON.stringify(value, null, 2), options);
}
