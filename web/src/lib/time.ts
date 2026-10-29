/** 时间显示：聊天里只需要“几点”和“哪天”。 */

const MINUTE = 60_000;
/** 超过这个间隔就插一条时间分隔线（微信/Telegram 的手感） */
export const DIVIDER_GAP = 5 * MINUTE;

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

/** 时分秒，如 09:03:07。 */
export function formatClock(timestamp: number): string {
  const d = new Date(timestamp);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 时分（分隔线用，短一点更干净）。 */
function formatClockShort(timestamp: number): string {
  const d = new Date(timestamp);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 年月日，如 2026-10-28。 */
function formatDate(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 消息底部的时间戳：**当天只显示时分秒**；不是当天，前面补上年月日。
 * 例：`09:03:07` / `2026-10-28 09:03:07`。
 */
export function formatStamp(timestamp: number): string {
  const time = formatClock(timestamp);
  return sameDay(new Date(timestamp), new Date()) ? time : `${formatDate(timestamp)} ${time}`;
}

/** 用时：<60s 用秒（`12s`），>=60s 用分秒（`1m23s`）。 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

/** 今天只显示时间；昨天显示“昨天 14:03”；更早带日期。 */
export function formatDivider(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  if (sameDay(date, now)) return formatClockShort(timestamp);

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return `昨天 ${formatClockShort(timestamp)}`;

  return `${date.getMonth() + 1}/${date.getDate()} ${formatClockShort(timestamp)}`;
}

/** 一整条 entry 的纯文本（供“引用”用）。 */
export function blocksToQuote(blocks: { type: string; text?: string }[], limit = 240): string {
  const text = blocks
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text as string)
    .join("\n")
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
