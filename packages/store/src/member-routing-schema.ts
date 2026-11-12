export const memberRoutingDDL = `
  CREATE TABLE IF NOT EXISTS tool_installations (
    id TEXT PRIMARY KEY,
    tool_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    executable_path TEXT NOT NULL,
    executable_args_json TEXT NOT NULL DEFAULT '[]',
    environment_keys_json TEXT NOT NULL DEFAULT '[]',
    version TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS session_member_routes (
    agent_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    access_mode TEXT NOT NULL CHECK (access_mode IN ('managed_proxy','mcp_await','cli_await','core_runtime')),
    binding_status TEXT NOT NULL CHECK (binding_status IN ('initializing','ready','blocked','disabled')),
    binding_version INTEGER NOT NULL DEFAULT 1 CHECK (binding_version > 0),
    binding_json TEXT,
    native_session_key TEXT,
    verified_at TEXT,
    verified_tool_version TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (access_mode = 'managed_proxy' AND (binding_status != 'ready' OR (binding_json IS NOT NULL AND native_session_key IS NOT NULL))) OR
      (access_mode != 'managed_proxy' AND binding_json IS NULL AND native_session_key IS NULL)
    )
  );
  CREATE INDEX IF NOT EXISTS idx_member_routes_session ON session_member_routes(session_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_member_routes_native_session
    ON session_member_routes(native_session_key)
    WHERE native_session_key IS NOT NULL AND binding_status != 'disabled';

  CREATE TABLE IF NOT EXISTS member_route_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    binding_version INTEGER NOT NULL,
    reason TEXT NOT NULL,
    before_json TEXT NOT NULL,
    after_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_member_route_events_agent ON member_route_events(agent_id, binding_version);

  CREATE TRIGGER IF NOT EXISTS member_route_agent_insert AFTER INSERT ON agents BEGIN
    INSERT OR IGNORE INTO session_member_routes (
      agent_id, session_id, access_mode, binding_status, binding_version, created_at, updated_at
    ) VALUES (NEW.id, NEW.session_id, 'cli_await', 'ready', 1, NEW.created_at, NEW.created_at);
  END;
  CREATE TRIGGER IF NOT EXISTS member_route_agent_delete AFTER DELETE ON agents BEGIN
    DELETE FROM session_member_routes WHERE agent_id = OLD.id;
  END;
  CREATE TRIGGER IF NOT EXISTS member_route_runtime_insert AFTER INSERT ON web_agent_runtimes BEGIN
    UPDATE session_member_routes SET access_mode = 'core_runtime', binding_version = binding_version + 1,
      updated_at = NEW.updated_at WHERE agent_id = NEW.agent_id AND access_mode != 'managed_proxy';
  END;
  CREATE TRIGGER IF NOT EXISTS member_route_runtime_delete AFTER DELETE ON web_agent_runtimes BEGIN
    UPDATE session_member_routes SET access_mode = 'cli_await', binding_version = binding_version + 1,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE agent_id = OLD.agent_id AND access_mode = 'core_runtime';
  END;
  CREATE TRIGGER IF NOT EXISTS member_route_check_insert BEFORE INSERT ON session_member_routes
  WHEN NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.agent_id AND session_id = NEW.session_id)
  BEGIN SELECT RAISE(ABORT, 'Member route does not belong to this session'); END;
  CREATE TRIGGER IF NOT EXISTS member_route_check_update BEFORE UPDATE ON session_member_routes
  WHEN NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.agent_id AND session_id = NEW.session_id)
  BEGIN SELECT RAISE(ABORT, 'Member route does not belong to this session'); END;
`;

export const backfillMemberRoutes = `
  INSERT OR IGNORE INTO session_member_routes (
    agent_id, session_id, access_mode, binding_status, binding_version, created_at, updated_at
  ) SELECT a.id, a.session_id,
    CASE WHEN EXISTS (SELECT 1 FROM web_agent_runtimes r WHERE r.agent_id = a.id)
      THEN 'core_runtime' ELSE 'cli_await' END,
    'ready', 1, a.created_at, a.created_at
  FROM agents a;
`;
