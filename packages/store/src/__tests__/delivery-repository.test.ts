import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type {
  Agent,
  MessageRecord,
  SessionMemberRoute,
} from "@loopmarshal/protocol";
import { schemaDDL } from "../schema.js";
import { runMigrations } from "../migrations.js";
import { AgentRepository } from "../repositories/agent-repository.js";
import { SessionRepository } from "../repositories/session-repository.js";
import { MemberRouteRepository } from "../repositories/member-route-repository.js";
import { MessageRepository } from "../repositories/message-repository.js";
import { DeliveryRepository } from "../repositories/delivery-repository.js";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture() {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec(schemaDDL);
  runMigrations(database);
  const timestamp = new Date().toISOString();
  const sessionId = randomUUID();
  const agents = new AgentRepository(database);
  const host: Agent = {
    id: randomUUID(),
    sessionId,
    agentName: "主控",
    displayName: "主控",
    platform: "generic",
    role: "host",
    roleDescription: null,
    capabilities: [],
    connectionMode: "skill-bridge",
    status: "online",
    lastHeartbeatAt: timestamp,
    createdAt: timestamp,
  };
  const worker: Agent = {
    ...host,
    id: randomUUID(),
    agentName: "前端开发",
    role: "worker",
  };
  new SessionRepository(database).insert({
    id: sessionId,
    name: "test",
    hostAgentId: host.id,
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  agents.insert(host);
  agents.insert(worker);
  const routes = new MemberRouteRepository(database);
  const installation = {
    id: randomUUID(),
    toolId: "codex" as const,
    displayName: "Codex",
    executablePath: process.execPath,
    executableArgs: [],
    environmentKeys: [],
    version: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  routes.insertInstallation(installation);
  const before = routes.get(worker.id)!;
  const route: SessionMemberRoute = {
    ...before,
    accessMode: "managed_proxy",
    bindingStatus: "ready",
    bindingVersion: 2,
    binding: {
      installationId: installation.id,
      workspacePath: "/project",
      runtimeNamespace: "/data",
      nativeSessionId: "123",
      endpoint: null,
    },
    nativeSessionKey: "native-123",
  };
  routes.update(route, 1, {
    id: randomUUID(),
    sessionId,
    agentId: worker.id,
    bindingVersion: 2,
    reason: "fixture",
    before,
    after: route,
    createdAt: timestamp,
  });
  const deliveries = new DeliveryRepository(database);
  const messages = new MessageRepository(database);
  messages.setDeliveryRepository(deliveries);
  const message = (key: string = randomUUID()): MessageRecord => ({
    id: randomUUID(),
    sessionId,
    fromAgentId: host.id,
    toAgentId: worker.id,
    type: "task",
    payload: { content: "task" },
    processingStatus: "pending",
    deliveryStatus: "sent",
    idempotencyKey: key,
    createdAt: timestamp,
  });
  const send = (input = message(), supersedeMessageIds: string[] = []) =>
    messages.insertAtomically({
      message: input,
      processedAt: timestamp,
      supersedeMessageIds,
    })!;
  return {
    database,
    routes,
    deliveries,
    messages,
    message,
    send,
    worker,
    host,
    sessionId,
    installation,
  };
}

describe("durable proxy outbox", () => {
  it("commits one message and delivery for repeated idempotency keys", () => {
    const f = fixture();
    const first = f.send(f.message("same-operation"));
    const second = f.send(f.message("same-operation"));
    expect(second.idempotent).toBe(true);
    expect(second.message.id).toBe(first.message.id);
    expect(f.deliveries.list(f.sessionId)).toHaveLength(1);
  });

  it("rolls back message insertion if a durable delivery cannot be created", () => {
    const f = fixture();
    f.database
      .prepare("DELETE FROM tool_installations WHERE id = ?")
      .run(f.installation.id);
    const message = f.message();
    expect(() => f.send(message)).toThrow(/installation/);
    expect(f.messages.findById(message.id)).toBeNull();
    expect(f.deliveries.list(f.sessionId)).toHaveLength(0);
  });

  it("serializes the native conversation and excludes both legacy claim paths", () => {
    const f = fixture();
    const first = f.send().message;
    f.send();
    expect(
      f.messages.claimNextForAgent(f.worker.id, new Date().toISOString()),
    ).toBeNull();
    expect(
      f.messages.claimManyForAgent(f.worker.id, new Date().toISOString()),
    ).toEqual([]);
    const claimed = f.deliveries.claim("supervisor-1");
    expect(claimed?.messageId).toBe(first.id);
    expect(f.messages.findById(first.id)?.processingStatus).toBe("claimed");
    expect(f.deliveries.claim("supervisor-2")).toBeNull();
  });

  it("supersedes queued deliveries atomically but refuses supersession after execution starts", () => {
    const f = fixture();
    const first = f.send().message;
    const merged = f.send(f.message(), [first.id]).message;
    expect(
      f.deliveries.list(f.sessionId).find((item) => item.messageId === first.id)
        ?.state,
    ).toBe("superseded");
    expect(f.deliveries.claim("supervisor")?.messageId).toBe(merged.id);
    const rejectedMessage = f.message();
    expect(
      f.messages.insertAtomically({
        message: rejectedMessage,
        supersedeMessageIds: [merged.id],
        processedAt: new Date().toISOString(),
      }),
    ).toBeNull();
    expect(f.messages.findById(rejectedMessage.id)).toBeNull();
  });

  it("blocks a queued snapshot whose binding version changed", () => {
    const f = fixture();
    f.send();
    f.database
      .prepare(
        "UPDATE session_member_routes SET binding_version = 3 WHERE agent_id = ?",
      )
      .run(f.worker.id);
    expect(f.deliveries.claim("supervisor")).toBeNull();
    expect(f.deliveries.list(f.sessionId)[0]?.state).toBe("blocked");
  });

  it("retains native-session occupancy and requires review after a crash", () => {
    const f = fixture();
    f.send();
    f.send();
    const claimed = f.deliveries.claim("old-core")!;
    f.deliveries.recoverInterrupted();
    expect(f.deliveries.get(claimed.id)?.state).toBe("unknown");
    expect(f.deliveries.claim("new-core")).toBeNull();
    expect(f.deliveries.activity(f.sessionId)).toEqual([
      {
        agentId: f.worker.id,
        queued: 1,
        running: 0,
        blocked: 0,
        unknown: 1,
        lastFailure: null,
      },
    ]);
    expect(() =>
      f.database.prepare("DELETE FROM agents WHERE id = ?").run(f.worker.id),
    ).toThrow(/MEMBER_ROUTE_BUSY/);
  });

  it("exposes the latest failed execution and clears it after a successful turn", () => {
    const f = fixture();
    f.send();
    const failed = f.deliveries.claim("core")!;
    f.deliveries.transition(
      failed.id,
      failed.attemptId!,
      ["delivering"],
      "failed",
      "Tool exited with code 1",
    );
    f.messages.markFailed(
      failed.messageId,
      f.worker.id,
      new Date().toISOString(),
      "Tool exited with code 1",
    );
    expect(f.deliveries.activity(f.sessionId)[0]?.lastFailure).toBe(
      "Tool exited with code 1",
    );
    f.send();
    const next = f.deliveries.claim("core")!;
    f.deliveries.transition(
      next.id,
      next.attemptId!,
      ["delivering"],
      "completed",
    );
    expect(f.deliveries.activity(f.sessionId)[0]?.lastFailure).toBeNull();
  });
});
