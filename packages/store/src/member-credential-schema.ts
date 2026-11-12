export const memberCredentialDDL = `
  CREATE TABLE IF NOT EXISTS member_credentials (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    label TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_member_credentials_agent ON member_credentials(session_id, agent_id);
  CREATE TRIGGER IF NOT EXISTS member_credentials_agent_delete AFTER DELETE ON agents BEGIN
    DELETE FROM member_credentials WHERE agent_id = OLD.id;
  END;
`;
