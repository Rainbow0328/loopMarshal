import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  DeliveryEvent,
  DeliveryState,
  MemberActivity,
  MessageRecord,
  ProxyDelivery,
  ProxyTargetSnapshot,
} from "@loopmarshal/protocol";
import { MemberRouteRepository } from "./member-route-repository.js";
import { inStoreTransaction } from "../transaction.js";

type DeliveryRow = Omit<ProxyDelivery, "snapshot"> & { snapshotJson: string };
const columns = `id, sequence, message_id AS messageId, session_id AS sessionId, target_agent_id AS targetAgentId,
  reply_to_agent_id AS replyToAgentId, binding_version AS bindingVersion, snapshot_json AS snapshotJson,
  state, attempt_id AS attemptId, owner_id AS ownerId, result_message_id AS resultMessageId, error,
  created_at AS createdAt, updated_at AS updatedAt`;

export class DeliveryRepository {
  private readonly routes: MemberRouteRepository;
  public constructor(private readonly database: DatabaseSync) {
    this.routes = new MemberRouteRepository(database);
  }

  /** Called within the message insert transaction, never after commit. */
  public enqueue(message: MessageRecord): void {
    const hostReport =
      message.type === "result" &&
      message.toAgentId !== message.fromAgentId &&
      this.database
        .prepare("SELECT 1 FROM agents WHERE id = ? AND role = 'host'")
        .get(message.toAgentId ?? null);
    if (
      !message.toAgentId ||
      (!hostReport && !["task", "instruction"].includes(message.type))
    )
      return;
    const route = this.routes.get(message.toAgentId);
    if (
      route?.accessMode !== "managed_proxy" ||
      !route.binding ||
      !route.nativeSessionKey
    )
      return;
    const installation = this.routes.getInstallation(
      route.binding.installationId,
    );
    if (!installation)
      throw new Error(
        "Proxy installation is missing; message was not accepted.",
      );
    const snapshot: ProxyTargetSnapshot = {
      binding: route.binding,
      installation,
      nativeSessionKey: route.nativeSessionKey,
    };
    this.database
      .prepare(
        `INSERT INTO message_deliveries
      (id, message_id, session_id, target_agent_id, reply_to_agent_id, binding_version, native_session_key, snapshot_json, state, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        message.id,
        message.sessionId,
        message.toAgentId,
        message.fromAgentId,
        route.bindingVersion,
        route.nativeSessionKey,
        JSON.stringify(snapshot),
        ["ready", "initializing"].includes(route.bindingStatus)
          ? "queued"
          : "blocked",
        ["ready", "initializing"].includes(route.bindingStatus)
          ? null
          : (route.lastError ?? "Member binding is not ready"),
        message.createdAt,
        message.createdAt,
      );
  }

  public supersede(messageIds: string[], timestamp: string): void {
    for (const id of messageIds) {
      const delivery = this.database
        .prepare("SELECT state FROM message_deliveries WHERE message_id = ?")
        .get(id) as { state: DeliveryState } | undefined;
      if (delivery && !["queued", "blocked"].includes(delivery.state))
        throw new Error("Cannot supersede a started proxy delivery.");
      this.database
        .prepare(
          "UPDATE message_deliveries SET state = 'superseded', updated_at = ? WHERE message_id = ? AND state IN ('queued','blocked')",
        )
        .run(timestamp, id);
    }
  }

  public get(id: string): ProxyDelivery | null {
    const row = this.database
      .prepare(`SELECT ${columns} FROM message_deliveries WHERE id = ?`)
      .get(id) as DeliveryRow | undefined;
    return row ? this.map(row) : null;
  }

  public rebind(
    id: string,
    attemptId: string,
    snapshot: ProxyTargetSnapshot,
    bindingVersion: number,
  ): boolean {
    const result = this.database
      .prepare(
        `UPDATE message_deliveries SET native_session_key = ?, snapshot_json = ?, binding_version = ?, updated_at = ?
      WHERE id = ? AND attempt_id = ? AND state IN ('delivering','awaiting_result')`,
      )
      .run(
        snapshot.nativeSessionKey,
        JSON.stringify(snapshot),
        bindingVersion,
        new Date().toISOString(),
        id,
        attemptId,
      );
    return Number(result.changes) === 1;
  }

  /** Move tasks queued behind a first-session creation onto the exact ID returned by that creation. */
  public bindQueuedNativeCreation(
    agentId: string,
    previousVersion: number,
    snapshot: ProxyTargetSnapshot,
    bindingVersion: number,
  ): number {
    const result = this.database
      .prepare(
        `UPDATE message_deliveries SET native_session_key = ?, snapshot_json = ?, binding_version = ?, updated_at = ?
      WHERE target_agent_id = ? AND binding_version = ? AND state = 'queued' AND attempt_id IS NULL`,
      )
      .run(
        snapshot.nativeSessionKey,
        JSON.stringify(snapshot),
        bindingVersion,
        new Date().toISOString(),
        agentId,
        previousVersion,
      );
    return Number(result.changes);
  }

  public retryNativeCreation(
    agentId: string,
    snapshot: ProxyTargetSnapshot,
    bindingVersion: number,
  ): void {
    const rows = this.database
      .prepare(
        "SELECT id, message_id AS messageId FROM message_deliveries WHERE target_agent_id = ? AND state = 'blocked' AND attempt_id IS NULL",
      )
      .all(agentId) as Array<{ id: string; messageId: string }>;
    for (const row of rows) {
      this.database
        .prepare(
          `UPDATE message_deliveries SET state = 'queued', error = NULL, binding_version = ?, native_session_key = ?, snapshot_json = ?, updated_at = ? WHERE id = ? AND state = 'blocked' AND attempt_id IS NULL`,
        )
        .run(
          bindingVersion,
          snapshot.nativeSessionKey,
          JSON.stringify(snapshot),
          new Date().toISOString(),
          row.id,
        );
      this.database
        .prepare(
          "UPDATE messages SET processing_status = 'pending', delivery_status = 'sent', failure_reason = NULL, failed_at = NULL WHERE id = ? AND processing_status = 'pending'",
        )
        .run(row.messageId);
    }
  }

  public list(sessionId: string, limit = 200): ProxyDelivery[] {
    return (
      this.database
        .prepare(
          `SELECT ${columns} FROM message_deliveries WHERE session_id = ? ORDER BY sequence DESC LIMIT ?`,
        )
        .all(sessionId, Math.max(1, Math.min(limit, 500))) as DeliveryRow[]
    ).map((row) => this.map(row));
  }

  public claim(ownerId: string): ProxyDelivery | null {
    return inStoreTransaction(this.database, () => {
      const candidates = this.database
        .prepare(
          `SELECT ${columns} FROM message_deliveries d WHERE state = 'queued'
        AND NOT EXISTS (SELECT 1 FROM message_deliveries other WHERE other.native_session_key = d.native_session_key
          AND other.sequence < d.sequence AND other.state IN ('queued','delivering','awaiting_result','blocked','unknown'))
        ORDER BY sequence LIMIT 50`,
        )
        .all() as DeliveryRow[];
      for (const row of candidates) {
        const route = this.routes.get(row.targetAgentId);
        if (
          !route ||
          route.bindingVersion !== row.bindingVersion ||
          !["ready", "initializing"].includes(route.bindingStatus) ||
          route.accessMode !== "managed_proxy"
        ) {
          this.database
            .prepare(
              "UPDATE message_deliveries SET state = 'blocked', error = ?, updated_at = ? WHERE id = ?",
            )
            .run(
              "Member binding changed or is no longer ready",
              new Date().toISOString(),
              row.id,
            );
          continue;
        }
        const timestamp = new Date().toISOString();
        const claimed = this.database
          .prepare(
            `UPDATE messages SET processing_status = 'claimed', delivery_status = 'delivered',
          claimed_by_agent_id = ?, claimed_at = ? WHERE id = ? AND processing_status = 'pending'
          AND NOT EXISTS (SELECT 1 FROM messages WHERE claimed_by_agent_id = ? AND processing_status = 'claimed')`,
          )
          .run(row.targetAgentId, timestamp, row.messageId, row.targetAgentId);
        if (Number(claimed.changes) !== 1) continue;
        const attemptId = randomUUID();
        this.database
          .prepare(
            "UPDATE message_deliveries SET state = 'delivering', attempt_id = ?, owner_id = ?, updated_at = ? WHERE id = ?",
          )
          .run(attemptId, ownerId, timestamp, row.id);
        this.database
          .prepare(
            "INSERT INTO delivery_attempts (id, delivery_id, owner_id, started_at) VALUES (?, ?, ?, ?)",
          )
          .run(attemptId, row.id, ownerId, timestamp);
        this.addEvent(row.id, attemptId, "spawn_intent", {});
        return this.get(row.id);
      }
      return null;
    });
  }

  public transition(
    id: string,
    attemptId: string,
    from: DeliveryState[],
    state: DeliveryState,
    error: string | null = null,
  ): boolean {
    const placeholders = from.map(() => "?").join(",");
    const result = this.database
      .prepare(
        `UPDATE message_deliveries SET state = ?, error = ?, updated_at = ?
      WHERE id = ? AND attempt_id = ? AND state IN (${placeholders})`,
      )
      .run(state, error, new Date().toISOString(), id, attemptId, ...from);
    return Number(result.changes) === 1;
  }

  public recordProcess(id: string, attemptId: string, pid: number): void {
    this.database
      .prepare(
        "UPDATE delivery_attempts SET process_id = ? WHERE id = ? AND delivery_id = ?",
      )
      .run(pid, attemptId, id);
  }

  public completeAttempt(
    attemptId: string,
    state: string,
    exitCode: number | null,
  ): void {
    this.database
      .prepare(
        "UPDATE delivery_attempts SET finished_at = ?, outcome = ?, exit_code = ? WHERE id = ?",
      )
      .run(new Date().toISOString(), state, exitCode, attemptId);
  }

  public setResult(id: string, messageId: string): void {
    this.database
      .prepare(
        "UPDATE message_deliveries SET result_message_id = ? WHERE id = ?",
      )
      .run(messageId, id);
  }

  public recoverInterrupted(): ProxyDelivery[] {
    return inStoreTransaction(this.database, () => {
      const rows = this.database
        .prepare(
          "SELECT id, attempt_id AS attemptId FROM message_deliveries WHERE state IN ('delivering','awaiting_result')",
        )
        .all() as Array<{ id: string; attemptId: string }>;
      for (const row of rows) {
        this.transition(
          row.id,
          row.attemptId,
          ["delivering", "awaiting_result"],
          "unknown",
          "Core restarted during execution. Verify native history and process state before resolving.",
        );
        this.addEvent(row.id, row.attemptId, "recovery_required", {});
      }
      return rows.map((row) => this.get(row.id)!);
    });
  }

  public unblockVerified(agentId: string, bindingVersion: number): void {
    this.database
      .prepare(
        `UPDATE message_deliveries SET state = 'queued', error = NULL, updated_at = ?
      WHERE target_agent_id = ? AND binding_version = ? AND state = 'blocked' AND attempt_id IS NULL`,
      )
      .run(new Date().toISOString(), agentId, bindingVersion);
  }

  public activity(sessionId: string): MemberActivity[] {
    return this.database
      .prepare(
        `SELECT target_agent_id AS agentId,
      SUM(state = 'queued') AS queued, SUM(state IN ('delivering','awaiting_result')) AS running,
      SUM(state = 'blocked') AS blocked, SUM(state = 'unknown') AS unknown,
      (SELECT CASE WHEN recent.state = 'failed' THEN recent.error ELSE NULL END
        FROM message_deliveries recent WHERE recent.target_agent_id = current.target_agent_id
        AND recent.state IN ('completed','failed') ORDER BY recent.sequence DESC LIMIT 1) AS lastFailure
      FROM message_deliveries current WHERE session_id = ? GROUP BY target_agent_id`,
      )
      .all(sessionId) as MemberActivity[];
  }

  public addEvent(
    deliveryId: string,
    attemptId: string | null,
    type: string,
    payload: unknown,
  ): void {
    this.database
      .prepare(
        "INSERT INTO delivery_events (delivery_id, attempt_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        deliveryId,
        attemptId,
        type,
        JSON.stringify(payload ?? null),
        new Date().toISOString(),
      );
  }

  public events(deliveryId: string, afterSequence = 0): DeliveryEvent[] {
    const rows = this.database
      .prepare(
        `SELECT sequence, delivery_id AS deliveryId, attempt_id AS attemptId,
      type, payload_json AS payloadJson, created_at AS createdAt FROM delivery_events
      WHERE delivery_id = ? AND sequence > ? ORDER BY sequence LIMIT 200`,
      )
      .all(deliveryId, afterSequence) as Array<
      Omit<DeliveryEvent, "payload"> & { payloadJson: string }
    >;
    return rows.map(({ payloadJson, ...row }) => ({
      ...row,
      payload: JSON.parse(payloadJson) as unknown,
    }));
  }

  private map({ snapshotJson, ...row }: DeliveryRow): ProxyDelivery {
    return {
      ...row,
      snapshot: JSON.parse(snapshotJson) as ProxyTargetSnapshot,
    };
  }
}
