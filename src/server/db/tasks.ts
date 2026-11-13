/**
 * tasks 表的两个只读查询：生成耗时、最近一次失败。
 *
 * 为什么要另开连接：pi-durable 的 SQLite 由 Harness 持有（它在写），
 * 我们只是想读两行数据给界面用。所以这里**惰性打开一个 readOnly 连接**，
 * 带 `busy_timeout`，读失败就吞掉 —— 辅助信息，绝不能让主流程挂掉。
 *
 * 三条必须保留的纪律：
 *  1. **惰性**：第一次真的要查才打开（不要在建 ctx 时就开）。
 *  2. **只读**：`readOnly: true` + `PRAGMA busy_timeout = 1000`。
 *  3. **duration 永久缓存**：task 结束后 record 不再变，重复查没有意义。
 *
 * 从 `context.ts` 原样搬出（SQL 与判断一字未改）。
 */
import { DatabaseSync } from "node:sqlite";

/** 最近一次失败的运行，随快照发给前端画红条。 */
export interface RunFailure {
  taskId: number;
  message: string;
  reason?: string;
  at?: number;
}

export interface TaskQueries {
  taskDuration: (taskId: number) => number | undefined;
  latestFailure: (conversationId: number) => RunFailure | null;
  /** 退出前关掉惰性打开的只读连接（没打开过就是空操作）。 */
  close: () => void;
}

export function openTaskQueries(dbPath: string): TaskQueries {
  let db: DatabaseSync | null = null;
  const durationCache = new Map<number, number | undefined>();

  /** 惰性打开的唯一出口：两个查询共用同一个只读连接。 */
  function handle(): DatabaseSync {
    if (!db) {
      db = new DatabaseSync(dbPath, { readOnly: true });
      db.exec("PRAGMA busy_timeout = 1000");
    }
    return db;
  }

  /**
   * 生成耗时（思考用时的兵底）：每条 assistant entry 的 `byTaskId` 对应 tasks 表里一次生成，
   * 记录有 startedAt/endedAt。前端实时计时（精确）会优先覆盖它；这里只给历史消息一个可复现的近似值。
   */
  function taskDuration(taskId: number): number | undefined {
    if (durationCache.has(taskId)) return durationCache.get(taskId);
    let value: number | undefined;
    try {
      const row = handle().prepare("SELECT record FROM tasks WHERE id = ?").get(taskId) as
        | { record?: string }
        | undefined;
      if (row?.record) {
        const record = JSON.parse(row.record) as { startedAt?: unknown; endedAt?: unknown };
        if (typeof record.startedAt === "number" && typeof record.endedAt === "number") {
          value = Math.max(0, record.endedAt - record.startedAt);
        }
      }
    } catch {
      /* 读不到就当没有，不影响主流程 */
    }
    durationCache.set(taskId, value);
    return value;
  }

  /**
   * 最近一次失败的运行。
   *
   * 为什么需要：模型不可达（隧道断了、API key 失效、被限流）时，pi-durable 只把任务标成
   * `failed`，**不会往对话里写任何东西** —— 用户看到的就是「消息发出去，永远没有回复」。
   * 实测过：隧道断了之后界面完全没提示，只能靠猜。
   */
  function latestFailure(conversationId: number): RunFailure | null {
    try {
      const row = handle()
        .prepare(
          "SELECT id, record FROM tasks WHERE conversation_id = ? AND status = 'terminal' ORDER BY id DESC LIMIT 1",
        )
        .get(conversationId) as { id?: number; record?: string } | undefined;
      if (!row?.record) return null;

      const record = JSON.parse(row.record) as {
        endedAt?: unknown;
        state?: { outcome?: { status?: string; error?: { message?: string; detail?: { reason?: string } } } };
      };
      const outcome = record.state?.outcome;
      if (outcome?.status !== "failed") return null;

      return {
        taskId: Number(row.id),
        message: outcome.error?.message ?? "运行失败",
        ...(outcome.error?.detail?.reason ? { reason: outcome.error.detail.reason } : {}),
        ...(typeof record.endedAt === "number" ? { at: record.endedAt } : {}),
      };
    } catch {
      return null;
    }
  }

  function close(): void {
    try {
      db?.close();
    } catch {
      /* 关不上也别在退出路上抛异常 */
    }
    db = null;
  }

  return { taskDuration, latestFailure, close };
}
