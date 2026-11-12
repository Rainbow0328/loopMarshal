import { hostname } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { inStoreTransaction } from "@loopmarshal/store";

/** A dead local owner may be replaced; a live or uncheckable owner is never fenced by time alone. */
export function acquireProxyCoreOwnership(
  database: DatabaseSync,
  ownerId: string,
): void {
  inStoreTransaction(database, () => {
    // Take SQLite's write lock before examining ownership, including across Core processes.
    database
      .prepare(
        "UPDATE proxy_core_owner SET singleton = singleton WHERE singleton = 1",
      )
      .run();
    const current = database
      .prepare(
        "SELECT owner_id AS ownerId, hostname, process_id AS pid FROM proxy_core_owner WHERE singleton = 1",
      )
      .get() as { ownerId: string; hostname: string; pid: number } | undefined;
    if (current && current.ownerId !== ownerId) {
      let alive = true;
      if (current.hostname === hostname()) {
        try {
          process.kill(current.pid, 0);
        } catch (error) {
          alive = (error as NodeJS.ErrnoException).code !== "ESRCH";
        }
      }
      if (alive)
        throw new Error(
          "这份数据已由另一个 Core 管理，请先关闭原实例。无法确认原实例已停止时，不会接管执行。",
        );
    }
    database
      .prepare(
        `INSERT INTO proxy_core_owner (singleton, owner_id, hostname, process_id) VALUES (1, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET owner_id = excluded.owner_id, hostname = excluded.hostname, process_id = excluded.process_id`,
      )
      .run(ownerId, hostname(), process.pid);
  });
}

export function releaseProxyCoreOwnership(
  database: DatabaseSync,
  ownerId: string,
): void {
  database
    .prepare(
      "DELETE FROM proxy_core_owner WHERE singleton = 1 AND owner_id = ?",
    )
    .run(ownerId);
}
