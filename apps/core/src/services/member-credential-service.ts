import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { MemberCredential } from "@loopmarshal/protocol";
import { CoreError } from "../errors.js";

const columns =
  "id, session_id AS sessionId, agent_id AS agentId, label, created_at AS createdAt, revoked_at AS revokedAt";
const denied = () =>
  new CoreError(
    "PERMISSION_DENIED",
    "A valid credential for the sending member is required.",
    403,
  );

export class MemberCredentialService {
  public constructor(private readonly database: DatabaseSync) {}

  public revokeExecutionCredentials(): void {
    this.database
      .prepare(
        "UPDATE member_credentials SET revoked_at = ? WHERE label LIKE 'proxy-execution:%' AND revoked_at IS NULL",
      )
      .run(new Date().toISOString());
  }

  public issue(
    sessionId: string,
    agentId: string,
    label: string,
  ): { credential: MemberCredential; token: string } {
    this.requireMember(sessionId, agentId);
    const credential: MemberCredential = {
      id: randomUUID(),
      sessionId,
      agentId,
      label,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    const token = `lm_member_${randomBytes(32).toString("hex")}`;
    this.database
      .prepare(
        `INSERT INTO member_credentials (id, session_id, agent_id, label, token_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        credential.id,
        sessionId,
        agentId,
        label,
        this.hash(token),
        credential.createdAt,
      );
    return { credential, token };
  }

  public list(sessionId: string, agentId: string): MemberCredential[] {
    this.requireMember(sessionId, agentId);
    return this.database
      .prepare(
        `SELECT ${columns} FROM member_credentials WHERE session_id = ? AND agent_id = ? ORDER BY created_at`,
      )
      .all(sessionId, agentId) as MemberCredential[];
  }

  public revoke(sessionId: string, agentId: string, id: string): void {
    this.requireMember(sessionId, agentId);
    const result = this.database
      .prepare(
        "UPDATE member_credentials SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND session_id = ? AND agent_id = ?",
      )
      .run(new Date().toISOString(), id, sessionId, agentId);
    if (!result.changes)
      throw new CoreError(
        "INVALID_INPUT",
        "Member credential was not found.",
        404,
      );
  }

  public authenticate(token: string): MemberCredential {
    if (token.length > 200 || !token.startsWith("lm_member_")) throw denied();
    const row = this.database
      .prepare(
        `SELECT ${columns} FROM member_credentials WHERE token_hash = ? AND revoked_at IS NULL`,
      )
      .get(this.hash(token)) as MemberCredential | undefined;
    if (!row) throw denied();
    this.requireMember(row.sessionId, row.agentId);
    return row;
  }

  public assertSender(token: string, sessionId: string, agentId: string): void {
    const credential = this.authenticate(token);
    if (credential.sessionId !== sessionId || credential.agentId !== agentId)
      throw denied();
  }

  private requireMember(sessionId: string, agentId: string): void {
    if (
      !this.database
        .prepare("SELECT 1 FROM agents WHERE id = ? AND session_id = ?")
        .get(agentId, sessionId)
    )
      throw denied();
  }
  private hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }
}
