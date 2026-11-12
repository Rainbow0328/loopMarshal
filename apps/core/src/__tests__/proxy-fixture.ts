import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DatabaseManager,
  AgentRepository,
  DeliveryRepository,
  IdentityLeaseRepository,
  MemberRouteRepository,
  MessageRepository,
  SessionRepository,
  SessionInsightRepository,
  TaskEventRepository,
  TaskRepository,
} from "@loopmarshal/store";
import { MemberRouteService } from "../services/member-route-service.js";
import { SessionService } from "../services/session-service.js";
import { MessageService } from "../services/message-service.js";

export function createProxyFixture() {
  const directory = mkdtempSync(join(tmpdir(), "loopmarshal-proxy-"));
  const manager = new DatabaseManager(join(directory, "test.sqlite"));
  manager.migrate();
  const database: DatabaseSync = manager.connection;
  const agents = new AgentRepository(database);
  const sessions = new SessionRepository(database);
  const messages = new MessageRepository(database);
  const routes = new MemberRouteRepository(database);
  const deliveries = new DeliveryRepository(database);
  messages.setDeliveryRepository(deliveries);
  const leases = new IdentityLeaseRepository(database);
  const sessionService = new SessionService(
    database,
    sessions,
    agents,
    messages,
    new TaskRepository(database),
    new TaskEventRepository(database),
    new SessionInsightRepository(database),
    leases,
  );
  const routeService = new MemberRouteService(
    database,
    routes,
    sessions,
    agents,
    sessionService,
  );
  const { session, agent: host } = sessionService.createSession({
    sessionName: "test",
    agentName: "主控",
    displayName: "主控",
    platform: "generic",
    capabilities: [],
    connectionMode: "skill-bridge",
  });
  const installation = routeService.createInstallation({
    toolId: "codex",
    displayName: "fixture",
    executablePath: process.execPath,
  });
  const proxy = routeService.createProxyMember(session.id, {
    agentName: "前端开发",
    roleDescription: "Frontend",
    binding: {
      installationId: installation.id,
      workspacePath: directory,
      runtimeNamespace: directory,
      nativeSessionId: "native-123",
    },
  });
  const messageService = new MessageService(sessions, agents, messages, leases);
  const send = (content = "Implement task") =>
    messageService.sendMessage({
      sessionId: session.id,
      fromAgentId: host.id,
      toAgentId: proxy.agent.id,
      type: "task",
      payload: { content },
      correlationId: "task-thread-1",
    });
  return {
    database,
    directory,
    agents,
    sessions,
    routes,
    messages,
    deliveries,
    sessionService,
    routeService,
    messageService,
    session,
    host,
    proxy,
    send,
    close: () => {
      manager.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
