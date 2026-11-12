import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { schemaDDL } from "./schema.js";
import { migrations, runMigrations } from "./migrations.js";

export class DatabaseManager {
  private readonly database: DatabaseSync;

  public constructor(private readonly databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
  }

  public get connection(): DatabaseSync {
    return this.database;
  }

  /**
   * 执行数据库迁移。
   *
   * 1. 先执行 schemaDDL 创建表结构（CREATE TABLE IF NOT EXISTS）
   * 2. 然后按版本号顺序执行迁移脚本
   *
   * 迁移脚本在 migrations.ts 中定义，每个迁移有版本号和描述。
   * schema_version 表记录已应用的版本，跳过已执行的迁移。
   */
  public migrate(): void {
    const populated = this.database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
      )
      .get();
    if (populated && this.databasePath !== ":memory:") {
      const hasVersions = this.database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'",
        )
        .get();
      const versions = hasVersions
        ? (this.database
            .prepare("SELECT version FROM schema_version")
            .all() as Array<{ version: number }>)
        : [];
      const applied = new Set(versions.map((row) => row.version));
      if (migrations.some((migration) => !applied.has(migration.version))) {
        const previous = Math.max(0, ...applied);
        // SQLite produces a consistent backup, including committed WAL pages.
        const backupPath = `${resolve(this.databasePath)}.pre-migration-v${previous}-${Date.now()}-${randomUUID()}.bak`;
        this.database.prepare("VACUUM INTO ?").run(backupPath);
      }
    }
    this.database.exec(schemaDDL);
    runMigrations(this.database);
  }

  public close(): void {
    this.database.close();
  }
}
