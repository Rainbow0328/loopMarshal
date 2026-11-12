import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { schemaDDL } from "../schema.js";
import {
  runMigrations,
  migrations,
  ensureColumnIfExists,
} from "../migrations.js";
import { SessionInsightRepository } from "../repositories/session-insight-repository.js";
import type { PendingUserInput } from "@loopmarshal/protocol";
import { memberRoutingDDL } from "../member-routing-schema.js";
import { deliveryDDL } from "../delivery-schema.js";
import { memberCredentialDDL } from "../member-credential-schema.js";
import { DatabaseManager } from "../database.js";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(schemaDDL);
  return db;
}

describe("Database Migrations", () => {
  it("adds an optional project directory to version 15 sessions without changing their identity", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(schemaDDL.replace("project_path TEXT,", ""));
      for (const migration of migrations.filter(
        (item) => item.version > 1 && item.version < 16,
      )) {
        migration.up(db);
        db.prepare("INSERT INTO schema_version VALUES (?, ?)").run(
          migration.version,
          "before",
        );
      }
      db.prepare(
        "INSERT INTO sessions (id,name,host_agent_id,status,created_at,updated_at) VALUES ('legacy-id','legacy','host','active','before','before')",
      ).run();
      expect(runMigrations(db)).toBe(1);
      expect(
        db.prepare("SELECT id,name,project_path FROM sessions").get(),
      ).toEqual({ id: "legacy-id", name: "legacy", project_path: null });
      expect(runMigrations(db)).toBe(0);
    } finally {
      db.close();
    }
  });
  it("backs up an existing database before upgrading and does not repeat the backup on restart", () => {
    const root = mkdtempSync(join(tmpdir(), "loopmarshal-migration-backup-"));
    const path = join(root, "legacy.sqlite");
    try {
      const old = new DatabaseSync(path);
      old.exec(
        schemaDDL.slice(
          0,
          -(
            memberRoutingDDL.length +
            deliveryDDL.length +
            memberCredentialDDL.length
          ),
        ),
      );
      old.exec(
        "CREATE TABLE backup_evidence (value TEXT); INSERT INTO backup_evidence VALUES ('preserve me')",
      );
      old.close();
      const manager = new DatabaseManager(path);
      try {
        manager.migrate();
        manager.migrate();
      } finally {
        manager.close();
      }
      const backups = readdirSync(root).filter((name) => name.endsWith(".bak"));
      expect(backups).toHaveLength(1);
      const backup = new DatabaseSync(join(root, backups[0]!), {
        readOnly: true,
      });
      try {
        expect(
          backup.prepare("SELECT value FROM backup_evidence").get(),
        ).toMatchObject({ value: "preserve me" });
        expect(
          backup
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE name = 'session_member_routes'",
            )
            .get(),
        ).toBeUndefined();
      } finally {
        backup.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("upgrades version 9 members and their messages without fabricating native bindings", () => {
    const db = new DatabaseSync(":memory:");
    try {
      // The pre-routing schema is the unchanged version 9 portion, with no routing tables or triggers.
      db.exec(
        schemaDDL.slice(
          0,
          -(
            memberRoutingDDL.length +
            deliveryDDL.length +
            memberCredentialDDL.length
          ),
        ),
      );
      for (const migration of migrations.filter(
        (item) => item.version > 1 && item.version <= 9,
      )) {
        migration.up(db);
        db.prepare("INSERT INTO schema_version VALUES (?, ?)").run(
          migration.version,
          "before-upgrade",
        );
      }
      db.exec(`INSERT INTO sessions (id,name,host_agent_id,status,created_at,updated_at) VALUES ('s','legacy','host','active','before','before');
        INSERT INTO agents (id,session_id,agent_name,display_name,platform,role,capabilities_json,connection_mode,status,created_at,last_heartbeat_at)
          VALUES ('host','s','host','host','unknown','host','[]','skill-bridge','online','before','before'),
            ('worker','s','worker','worker','unknown','worker','[]','skill-bridge','online','before','before'),
            ('runtime','s','runtime','runtime','generic','worker','[]','skill-bridge','online','before','before');
        INSERT INTO web_agent_runtimes (id,session_id,agent_id,role,model_config_id,toolset_id,status,created_at,updated_at)
          VALUES ('r','s','runtime','worker','model','tools','stopped','before','before');
        INSERT INTO messages (id,session_id,from_agent_id,to_agent_id,type,payload_json,delivery_status,processing_status,created_at)
          VALUES ('old-message','s','host','worker','task','{"content":"keep me"}','sent','pending','before');`);
      expect(runMigrations(db)).toBe(migrations.length - 9);
      expect(
        db
          .prepare(
            "SELECT agent_id,access_mode,binding_json FROM session_member_routes ORDER BY agent_id",
          )
          .all(),
      ).toEqual([
        { agent_id: "host", access_mode: "cli_await", binding_json: null },
        {
          agent_id: "runtime",
          access_mode: "core_runtime",
          binding_json: null,
        },
        { agent_id: "worker", access_mode: "cli_await", binding_json: null },
      ]);
      expect(
        db
          .prepare(
            "SELECT processing_status FROM messages WHERE id = 'old-message'",
          )
          .get(),
      ).toMatchObject({ processing_status: "pending" });
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM message_deliveries").get(),
      ).toMatchObject({ count: 0 });
      expect(runMigrations(db)).toBe(0);
    } finally {
      db.close();
    }
  });
  it("runs all migrations on a fresh database", () => {
    const db = createTestDb();
    const count = runMigrations(db);
    // schemaDDL records version 1; all subsequent migrations still run.
    expect(count).toBe(migrations.length - 1);
    db.close();
  });

  it("skips already applied migrations on second run", () => {
    const db = createTestDb();
    const firstRun = runMigrations(db);
    const secondRun = runMigrations(db);
    expect(firstRun).toBe(migrations.length - 1);
    expect(secondRun).toBe(0);
    db.close();
  });

  it("creates schema_version table with all versions", () => {
    const db = createTestDb();
    runMigrations(db);
    const versions = db
      .prepare("SELECT version FROM schema_version ORDER BY version ASC")
      .all() as Array<{ version: number }>;
    expect(versions).toHaveLength(migrations.length);
    expect(versions[0]?.version).toBe(1);
    expect(versions[versions.length - 1]?.version).toBe(migrations.length);
    db.close();
  });

  it("ensureColumnIfExists is idempotent", () => {
    const db = createTestDb();
    db.exec("CREATE TABLE test_table (id TEXT PRIMARY KEY)");
    ensureColumnIfExists(db, "test_table", "name", "TEXT");
    ensureColumnIfExists(db, "test_table", "name", "TEXT"); // should not throw
    const columns = db.prepare("PRAGMA table_info(test_table)").all() as Array<{
      name: string;
    }>;
    expect(columns.map((c) => c.name)).toContain("name");
    db.close();
  });
});

// ============================================
// Version 8 迁移测试：string[] → PendingUserInput[]
// 使用真实 runMigrations() + SessionInsightRepository 验证
// ============================================

describe("Version 8 migration: unappliedUserInputs string[] → PendingUserInput[]", () => {
  function createDbWithOldData(): DatabaseSync {
    const db = createTestDb();

    // 只应用到 version 7（跳过 version 8）
    for (const migration of migrations) {
      if (migration.version === 8) break;
      // version 1 由 schemaDDL 处理，其他逐个执行
      if (migration.version > 1) {
        db.exec("BEGIN");
        try {
          migration.up(db);
          db.prepare(
            "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
          ).run(migration.version, new Date().toISOString());
          db.exec("COMMIT");
        } catch {
          db.exec("ROLLBACK");
          throw new Error(`migration ${migration.version} failed`);
        }
      } else {
        // version 1 已由 schemaDDL 插入
        db.prepare(
          "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, ?)",
        ).run(1, new Date().toISOString());
      }
    }

    return db;
  }

  it("migrates old string[] unappliedUserInputs to PendingUserInput[] with revision", () => {
    const db = createDbWithOldData();

    // 写入旧格式的 session insight（字符串数组）
    db.prepare(
      `
      INSERT INTO session_insights (
        session_id, objective, current_project_understanding, project_summary,
        user_intent_summary, latest_user_input, latest_report_summary,
        recent_user_inputs_json, unapplied_user_inputs_json, user_preferences_json,
        acceptance_criteria_json, constraints_json, completed_items_json,
        pending_items_json, blockers_json, assumptions_json,
        latest_user_directive_revision, applied_user_directive_revision,
        current_plan_revision, active_plan_summary, last_dispatch_worker_name,
        last_dispatch_agent_id, last_dispatch_message_id, last_dispatch_correlation_id,
        last_dispatch_task_focus, review_status, review_reason, ready_for_review,
        last_updated_by_agent_id, updated_at
      ) VALUES (
        'test-session-1', NULL, NULL, NULL, NULL, NULL, NULL,
        '[]', '["user input A", "user input B"]', '[]',
        '[]', '[]', '[]', '[]', '[]', '[]',
        7, 3, 0, NULL, NULL, NULL, NULL, NULL, NULL,
        'in_progress', NULL, 0, 'agent-1', '2024-01-01T00:00:00Z'
      )
    `,
    ).run();

    // Apply version 8 and all later migrations.
    const count = runMigrations(db);
    expect(count).toBe(
      migrations.filter((migration) => migration.version >= 8).length,
    );

    // 用真实 SessionInsightRepository 读取
    const repo = new SessionInsightRepository(db);
    const insight = repo.findBySessionId("test-session-1");

    expect(insight).not.toBeNull();
    const unapplied = insight!.unappliedUserInputs as PendingUserInput[];
    expect(unapplied).toHaveLength(2);
    expect(unapplied[0]).toEqual({ revision: 7, content: "user input A" });
    expect(unapplied[1]).toEqual({ revision: 7, content: "user input B" });

    db.close();
  });

  it("preserves already-structured entries in mixed-format arrays", () => {
    const db = createDbWithOldData();

    // 写入混合格式：一个已结构化 + 一个旧字符串
    db.prepare(
      `
      INSERT INTO session_insights (
        session_id, objective, current_project_understanding, project_summary,
        user_intent_summary, latest_user_input, latest_report_summary,
        recent_user_inputs_json, unapplied_user_inputs_json, user_preferences_json,
        acceptance_criteria_json, constraints_json, completed_items_json,
        pending_items_json, blockers_json, assumptions_json,
        latest_user_directive_revision, applied_user_directive_revision,
        current_plan_revision, active_plan_summary, last_dispatch_worker_name,
        last_dispatch_agent_id, last_dispatch_message_id, last_dispatch_correlation_id,
        last_dispatch_task_focus, review_status, review_reason, ready_for_review,
        last_updated_by_agent_id, updated_at
      ) VALUES (
        'test-session-mixed', NULL, NULL, NULL, NULL, NULL, NULL,
        '[]', '[{"revision": 4, "content": "already migrated"}, "legacy input"]', '[]',
        '[]', '[]', '[]', '[]', '[]', '[]',
        7, 3, 0, NULL, NULL, NULL, NULL, NULL, NULL,
        'in_progress', NULL, 0, 'agent-1', '2024-01-01T00:00:00Z'
      )
    `,
    ).run();

    runMigrations(db);

    const repo = new SessionInsightRepository(db);
    const insight = repo.findBySessionId("test-session-mixed");

    expect(insight).not.toBeNull();
    const unapplied = insight!.unappliedUserInputs as PendingUserInput[];
    // Both entries should be preserved: the structured one + the converted string
    expect(unapplied).toHaveLength(2);
    expect(unapplied[0]).toEqual({ revision: 4, content: "already migrated" });
    expect(unapplied[1]).toEqual({ revision: 7, content: "legacy input" });

    db.close();
  });

  it("is idempotent — second run does not alter already-migrated data", () => {
    const db = createDbWithOldData();

    db.prepare(
      `
      INSERT INTO session_insights (
        session_id, objective, current_project_understanding, project_summary,
        user_intent_summary, latest_user_input, latest_report_summary,
        recent_user_inputs_json, unapplied_user_inputs_json, user_preferences_json,
        acceptance_criteria_json, constraints_json, completed_items_json,
        pending_items_json, blockers_json, assumptions_json,
        latest_user_directive_revision, applied_user_directive_revision,
        current_plan_revision, active_plan_summary, last_dispatch_worker_name,
        last_dispatch_agent_id, last_dispatch_message_id, last_dispatch_correlation_id,
        last_dispatch_task_focus, review_status, review_reason, ready_for_review,
        last_updated_by_agent_id, updated_at
      ) VALUES (
        'test-session-idemp', NULL, NULL, NULL, NULL, NULL, NULL,
        '[]', '["original input"]', '[]',
        '[]', '[]', '[]', '[]', '[]', '[]',
        5, 2, 0, NULL, NULL, NULL, NULL, NULL, NULL,
        'in_progress', NULL, 0, 'agent-1', '2024-01-01T00:00:00Z'
      )
    `,
    ).run();

    // First migration
    runMigrations(db);
    const repo = new SessionInsightRepository(db);
    const afterFirst = repo.findBySessionId("test-session-idemp");
    expect(afterFirst!.unappliedUserInputs).toEqual([
      { revision: 5, content: "original input" },
    ]);

    // Second migration run — should be no-op
    const secondCount = runMigrations(db);
    expect(secondCount).toBe(0);
    const afterSecond = repo.findBySessionId("test-session-idemp");
    expect(afterSecond!.unappliedUserInputs).toEqual([
      { revision: 5, content: "original input" },
    ]);

    db.close();
  });
});
