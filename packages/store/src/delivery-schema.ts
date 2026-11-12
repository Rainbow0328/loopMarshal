export const deliveryDDL = `
  CREATE TABLE IF NOT EXISTS proxy_core_owner (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    owner_id TEXT NOT NULL,
    hostname TEXT NOT NULL,
    process_id INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS named_send_operations (
    session_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    request_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    PRIMARY KEY (session_id, sender_id, operation_key)
  );
  CREATE TABLE IF NOT EXISTS message_deliveries (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    message_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    target_agent_id TEXT NOT NULL,
    reply_to_agent_id TEXT NOT NULL,
    binding_version INTEGER NOT NULL,
    native_session_key TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued','delivering','awaiting_result','completed','failed','blocked','unknown','cancelled','superseded')),
    attempt_id TEXT,
    owner_id TEXT,
    result_message_id TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(message_id, target_agent_id)
  );
  CREATE INDEX IF NOT EXISTS idx_deliveries_queue ON message_deliveries(state, sequence);
  CREATE INDEX IF NOT EXISTS idx_deliveries_session ON message_deliveries(session_id, target_agent_id, sequence);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_native_writer ON message_deliveries(native_session_key)
    WHERE state IN ('delivering','awaiting_result','unknown');
  CREATE TABLE IF NOT EXISTS delivery_attempts (
    id TEXT PRIMARY KEY,
    delivery_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    process_id INTEGER,
    finished_at TEXT,
    outcome TEXT,
    exit_code INTEGER
  );
  CREATE TABLE IF NOT EXISTS delivery_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_id TEXT NOT NULL,
    attempt_id TEXT,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_delivery_events_delivery ON delivery_events(delivery_id, sequence);
  CREATE TRIGGER IF NOT EXISTS guard_delete_executing_member BEFORE DELETE ON agents
    WHEN EXISTS (SELECT 1 FROM message_deliveries WHERE target_agent_id = OLD.id
      AND state IN ('queued','delivering','awaiting_result','blocked','unknown'))
    BEGIN SELECT RAISE(ABORT, 'MEMBER_ROUTE_BUSY: resolve deliveries before removing this member'); END;
  CREATE TRIGGER IF NOT EXISTS guard_delete_executing_message BEFORE DELETE ON messages
    WHEN EXISTS (SELECT 1 FROM message_deliveries WHERE message_id = OLD.id
      AND state IN ('queued','delivering','awaiting_result','blocked','unknown'))
    BEGIN SELECT RAISE(ABORT, 'MEMBER_ROUTE_BUSY: resolve deliveries before deleting messages'); END;
`;
