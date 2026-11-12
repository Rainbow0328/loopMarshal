import type { DatabaseSync } from "node:sqlite";

let nextSavepoint = 0;

/** Synchronous unit of work; savepoints also compose with existing service transactions. */
export function inStoreTransaction<T>(
  database: DatabaseSync,
  operation: () => T,
): T {
  const savepoint = `loopmarshal_uow_${++nextSavepoint}`;
  database.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = operation();
    database.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    database.exec(`RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
}
