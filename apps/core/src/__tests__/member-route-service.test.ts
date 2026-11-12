import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRepository,
  IdentityLeaseRepository,
  MemberRouteRepository,
  MessageRepository,
  SessionRepository,
  SessionInsightRepository,
  TaskEventRepository,
  TaskRepository,
} from "@loopmarshal/store";
import { schemaDDL } from "../../../../packages/store/src/schema.js";
import { runMigrations } from "../../../../packages/store/src/migrations.js";
import { MemberRouteService } from "../services/member-route-service.js";
import { SessionService } from "../services/session-service.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "loopmarshal-routes-"));
  const workspacePath = join(directory, "project A 中文");
  const runtimeNamespace = join(directory, "native-data");
  mkdirSync(workspacePath);
  mkdirSync(runtimeNamespace);
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const database = new DatabaseSync(":memory:");
  cleanups.push(() => database.close());
  database.exec(schemaDDL);
  runMigrations(database);
  const agents = new AgentRepository(database);
  const sessions = new SessionRepository(database);
  const routes = new MemberRouteRepository(database);
  const sessionService = new SessionService(
    database,
    sessions,
    agents,
    new MessageRepository(database),
    new TaskRepository(database),
    new TaskEventRepository(database),
    new SessionInsightRepository(database),
    new IdentityLeaseRepository(database),
  );
  const service = new MemberRouteService(
    database,
    routes,
    sessions,
    agents,
    sessionService,
  );
  const installation = service.createInstallation({
    toolId: "codex",
    displayName: "test executable",
    executablePath: process.execPath,
  });
  const createSession = (name: string) =>
    sessionService.createSession({
      sessionName: name,
      agentName: "主控",
      displayName: "主控",
      platform: "generic",
      capabilities: [],
      connectionMode: "skill-bridge",
    });
  const binding = (nativeSessionId = "existing-session-one") => ({
    installationId: installation.id,
    workspacePath,
    runtimeNamespace,
    nativeSessionId,
  });
  return {
    database,
    agents,
    routes,
    service,
    sessionService,
    createSession,
    binding,
    installation,
  };
}

describe("persistent member routing", () => {
  it("can retry a failed new-session initialization without inventing a native ID", () => {
    const f = fixture();
    const session = f.createSession("new-native-session").session;
    const binding = f.binding();
    const member = f.service.createProxyMember(session.id, {
      agentName: "new-cli",
      roleDescription: "Worker",
      binding: {
        installationId: f.installation.id,
        workspacePath: binding.workspacePath,
        runtimeNamespace: binding.runtimeNamespace,
      },
    });
    expect(member.route.bindingStatus).toBe("initializing");
    expect(member.route.binding?.nativeSessionId).toMatch(
      /^loopmarshal-pending:/,
    );
    f.service.failNativeSessionCreation(
      session.id,
      member.agent.id,
      member.route.bindingVersion,
      "CLI failed to start",
    );
    const retried = f.service.retryNativeSessionCreation(
      session.id,
      member.agent.id,
      member.route.bindingVersion,
    );
    expect(retried.route).toMatchObject({
      bindingStatus: "initializing",
      bindingVersion: member.route.bindingVersion + 1,
      lastError: null,
    });
    expect(retried.route.binding?.nativeSessionId).toMatch(
      /^loopmarshal-pending:/,
    );
  });

  it("can explicitly switch an existing member binding to first-task session creation", () => {
    const f = fixture();
    const { session } = f.createSession("replace-with-new-history");
    const member = f.service.createProxyMember(session.id, {
      agentName: "new-cli",
      roleDescription: "Worker",
      binding: f.binding("old-history"),
    });
    const updated = f.service.update(session.id, member.agent.id, {
      accessMode: "managed_proxy",
      expectedBindingVersion: member.route.bindingVersion,
      binding: {
        installationId: f.installation.id,
        workspacePath: f.binding().workspacePath,
        runtimeNamespace: f.binding().runtimeNamespace,
      },
      reason: "Start a separate native history",
    });
    expect(updated.route).toMatchObject({
      accessMode: "managed_proxy",
      bindingStatus: "initializing",
      lastError: null,
    });
    expect(updated.route.nativeSessionKey).toEqual(expect.any(String));
    expect(updated.route.binding?.nativeSessionId).toMatch(
      /^loopmarshal-pending:/,
    );
  });

  it("updates a registered tool's launch settings without changing its tool identity", () => {
    const f = fixture();
    const updated = f.service.updateInstallation(f.installation.id, {
      displayName: "工作用 Codex",
      executableArgs: ["--verbose"],
      environmentKeys: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
      version: "1.2.3",
    });
    expect(updated).toMatchObject({
      id: f.installation.id,
      toolId: "codex",
      displayName: "工作用 Codex",
      executablePath: process.execPath,
      executableArgs: ["--verbose"],
      environmentKeys: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
      version: "1.2.3",
    });
    expect(f.service.listInstallations()[0]).toEqual(updated);
    expect(() =>
      f.service.updateInstallation(f.installation.id, { toolId: "claude" }),
    ).toThrow();
  });

  it("rejects missing executables and unsupported inherited environment keys", () => {
    const f = fixture();
    expect(() =>
      f.service.updateInstallation(f.installation.id, {
        executablePath: "relative/path",
      }),
    ).toThrow(/absolute/);
    expect(() =>
      f.service.updateInstallation(f.installation.id, {
        environmentKeys: ["UNSAFE_SECRET"],
      }),
    ).toThrow(/documented model environment keys/);
    expect(f.service.listInstallations()[0]).toEqual(f.installation);
  });

  it("registers legacy members without native-tool fields and preserves the route on attach", () => {
    const f = fixture();
    const { session } = f.createSession("test");
    const input = {
      sessionId: session.id,
      agentName: "代码审查",
      displayName: "代码审查",
      platform: "generic",
      role: "worker" as const,
      roleDescription: "Review code",
      capabilities: [],
      connectionMode: "skill-bridge" as const,
    };
    const { agent } = f.sessionService.joinSession(input);
    expect(f.service.get(session.id, agent.id).route).toMatchObject({
      accessMode: "cli_await",
      binding: null,
      bindingVersion: 1,
    });
    f.sessionService.joinSession(input);
    expect(f.service.list(session.id)).toHaveLength(2);
    expect(f.routes.get(agent.id)?.bindingVersion).toBe(1);
  });

  it("stores exact native sessions under session-scoped Chinese names, with a binding audit", () => {
    const f = fixture();
    const one = f.createSession("test").session;
    const two = f.createSession("another").session;
    const first = f.service.createProxyMember(one.id, {
      agentName: "前端开发",
      roleDescription: "Frontend",
      binding: f.binding("123"),
    });
    const second = f.service.createProxyMember(two.id, {
      agentName: "前端开发",
      roleDescription: "Frontend",
      binding: f.binding("456"),
    });
    expect(first.agent.id).not.toBe(second.agent.id);
    expect(first.route).toMatchObject({
      accessMode: "managed_proxy",
      bindingStatus: "blocked",
      bindingVersion: 2,
      binding: { nativeSessionId: "123" },
    });
    expect(f.service.listEvents(one.id, first.agent.id)[0]).toMatchObject({
      before: { accessMode: "cli_await" },
      after: first.route,
    });
    expect(() => f.service.get(two.id, first.agent.id)).toThrow(
      /does not belong/,
    );
  });

  it("does not let ordinary legacy reattachment overwrite a proxy binding", () => {
    const f = fixture();
    const { session } = f.createSession("test");
    const proxy = f.service.createProxyMember(session.id, {
      agentName: "前端开发",
      roleDescription: "Frontend",
      binding: f.binding(),
    });
    f.sessionService.joinSession({
      sessionId: session.id,
      agentName: "前端开发",
      displayName: "front",
      platform: "generic",
      role: "worker",
      roleDescription: "Frontend",
      capabilities: [],
      connectionMode: "skill-bridge",
    });
    expect(f.routes.get(proxy.agent.id)).toEqual(proxy.route);
  });

  it("rejects duplicate native bindings even through different installation aliases and rolls back the member", () => {
    const f = fixture();
    const { session } = f.createSession("test");
    f.service.createProxyMember(session.id, {
      agentName: "前端开发",
      roleDescription: "Frontend",
      binding: f.binding(),
    });
    const alias = f.service.createInstallation({
      toolId: "codex",
      displayName: "alias",
      executablePath: process.execPath,
    });
    expect(() =>
      f.service.createProxyMember(session.id, {
        agentName: "another",
        roleDescription: "Frontend",
        binding: { ...f.binding(), installationId: alias.id },
      }),
    ).toThrow(/already bound/);
    expect(
      f.agents.findBySessionIdAndAgentName(session.id, "another"),
    ).toBeNull();
    expect(f.service.list(session.id)).toHaveLength(2);
  });

  it("uses optimistic binding versions and can explicitly return to a tool-free waiting chain", () => {
    const f = fixture();
    const { session } = f.createSession("test");
    const proxy = f.service.createProxyMember(session.id, {
      agentName: "前端开发",
      roleDescription: "Frontend",
      binding: f.binding(),
    });
    expect(() =>
      f.service.update(session.id, proxy.agent.id, {
        accessMode: "cli_await",
        expectedBindingVersion: 1,
        reason: "stale",
      }),
    ).toThrow(/changed/);
    const updated = f.service.update(session.id, proxy.agent.id, {
      accessMode: "mcp_await",
      expectedBindingVersion: 2,
      reason: "explicit change",
    });
    expect(updated.route).toMatchObject({
      accessMode: "mcp_await",
      bindingStatus: "ready",
      binding: null,
      nativeSessionKey: null,
      bindingVersion: 3,
    });
    expect(f.service.listEvents(session.id, proxy.agent.id)).toHaveLength(2);
  });

  it("rejects invalid paths without leaving a partially registered member", () => {
    const f = fixture();
    const { session } = f.createSession("test");
    expect(() =>
      f.service.createProxyMember(session.id, {
        agentName: "invalid",
        roleDescription: "Frontend",
        binding: { ...f.binding(), workspacePath: "relative" },
      }),
    ).toThrow(/absolute/);
    expect(
      f.agents.findBySessionIdAndAgentName(session.id, "invalid"),
    ).toBeNull();
  });

  it("preserves disabled native bindings while allowing a replacement member to claim the resource", () => {
    const f = fixture();
    const { session } = f.createSession("test");
    const first = f.service.createProxyMember(session.id, {
      agentName: "前端开发",
      roleDescription: "Frontend",
      binding: f.binding(),
    });
    const disabled = f.service.update(session.id, first.agent.id, {
      accessMode: "managed_proxy",
      expectedBindingVersion: 2,
      binding: f.binding(),
      disabled: true,
      reason: "Replace worker",
    });
    expect(disabled.route.bindingStatus).toBe("disabled");
    const replacement = f.service.createProxyMember(session.id, {
      agentName: "替补",
      roleDescription: "Frontend",
      binding: f.binding(),
    });
    expect(replacement.route.binding?.nativeSessionId).toBe(
      first.route.binding?.nativeSessionId,
    );
    expect(() =>
      f.service.update(session.id, first.agent.id, {
        accessMode: "managed_proxy",
        expectedBindingVersion: 3,
        binding: f.binding(),
        reason: "Enable original worker",
      }),
    ).toThrow(/already bound/);
  });

  it("does not allow local server aliases to bind the same native conversation twice", () => {
    const f = fixture();
    const { session } = f.createSession("test");
    const installation = f.service.createInstallation({
      toolId: "opencode",
      displayName: "Server tool",
      executablePath: process.execPath,
    });
    const binding = {
      ...f.binding("ses_123"),
      installationId: installation.id,
      endpoint: "http://localhost:4096",
    };
    f.service.createProxyMember(session.id, {
      agentName: "one",
      roleDescription: "Frontend",
      binding,
    });
    expect(() =>
      f.service.createProxyMember(session.id, {
        agentName: "two",
        roleDescription: "Frontend",
        binding: { ...binding, endpoint: "http://127.0.0.1:4096/" },
      }),
    ).toThrow(/already bound/);
  });

  it("requires a native data directory for local CLIs but not for server-backed tools", () => {
    const f = fixture();
    const { session } = f.createSession("test");
    const local = f.service.createInstallation({
      toolId: "codex",
      displayName: "Local Codex",
      executablePath: process.execPath,
    });
    expect(() =>
      f.service.createProxyMember(session.id, {
        agentName: "local",
        roleDescription: "Local CLI",
        binding: {
          ...f.binding(),
          installationId: local.id,
          runtimeNamespace: "",
        },
      }),
    ).toThrow(/数据目录/);

    const serverTool = f.service.createInstallation({
      toolId: "opencode",
      displayName: "Server tool",
      executablePath: process.execPath,
    });
    const member = f.service.createProxyMember(session.id, {
      agentName: "server",
      roleDescription: "Server CLI",
      binding: {
        ...f.binding("ses_server"),
        installationId: serverTool.id,
        runtimeNamespace: "",
        endpoint: "http://127.0.0.1:4096",
      },
    });
    expect(member.route.binding).toMatchObject({
      runtimeNamespace: "",
      endpoint: "http://127.0.0.1:4096",
    });
  });
});
