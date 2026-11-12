import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer as createHttpServer } from "node:http";
import { startCoreServer } from "../runtime.js";
import { externalToolName } from "../services/external-tool-name.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const local = (role: string, name: string, extra = {}) => ({
  role,
  name,
  duty: `${role} responsibility`,
  mode: "core_runtime",
  modelConfigId: "default-model",
  ...extra,
});
const waiting = (role: string, name: string) => ({
  role,
  name,
  duty: `${role} responsibility`,
  mode: "mcp_await",
});
async function until<T>(
  read: () => Promise<T>,
  check: (value: T) => boolean,
): Promise<T> {
  for (let n = 0; n < 200; n++) {
    const result = await read();
    if (check(result)) return result;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("Timed out waiting for session execution");
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "loopmarshal-workspace-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const oldKnowledge = process.env.LOOPMARSHAL_KNOWLEDGE_ROOT;
  const oldPrefs = process.env.LOOPMARSHAL_USER_PREFERENCES_PATH;
  const oldBase = process.env.OPENAI_BASE_URL;
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.LOOPMARSHAL_KNOWLEDGE_ROOT = join(root, "knowledge");
  process.env.LOOPMARSHAL_USER_PREFERENCES_PATH = join(
    root,
    "preferences.json",
  );
  cleanup.push(() => {
    if (oldKnowledge === undefined)
      delete process.env.LOOPMARSHAL_KNOWLEDGE_ROOT;
    else process.env.LOOPMARSHAL_KNOWLEDGE_ROOT = oldKnowledge;
    if (oldPrefs === undefined)
      delete process.env.LOOPMARSHAL_USER_PREFERENCES_PATH;
    else process.env.LOOPMARSHAL_USER_PREFERENCES_PATH = oldPrefs;
    if (oldBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = oldBase;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
  });
  const project = join(root, "project");
  mkdirSync(project);
  writeFileSync(
    join(project, "README.md"),
    "# The selected project\nPROJECT_ORIENTATION_42",
  );
  writeFileSync(join(project, "source.txt"), "SOURCE_CONTENT_86");
  const core = await startCoreServer({
    host: "127.0.0.1",
    port: 0,
    databasePath: join(root, "core.sqlite"),
  });
  cleanup.push(core.close);
  const base = `http://127.0.0.1:${(core.server.server.address() as { port: number }).port}`;
  const { token } = (await (await fetch(base + "/api/local-auth")).json()) as {
    token: string;
  };
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        "x-loopmarshal-management-token": token,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const setup = async (
    name: string,
    agents: Array<Record<string, unknown>> = [waiting("host", "Host")],
  ) => {
    const host = agents.find((agent) => agent.role === "host")!;
    // External Hosts create sessions through attach, independently of the client setup form.
    if (host.mode === "mcp_await") {
      const attached = await request("/api/sessions/attach", "POST", {
        sessionName: name,
        projectPath: project,
        agentName: host.name,
        role: "host",
        roleDescription: host.duty,
      });
      expect(attached.status, JSON.stringify(attached.body)).toBe(200);
      const result = attached.body.data;
      const members = [result.agent];
      for (const selection of agents.filter((agent) => agent !== host)) {
        const joined = await request("/api/sessions/attach", "POST", {
          sessionName: name,
          agentName: selection.name,
          role: selection.role,
          roleDescription: selection.duty,
        });
        expect(joined.status, JSON.stringify(joined.body)).toBe(200);
        const agent = joined.body.data.agent;
        members.push(agent);
        if (selection.mode === "core_runtime") {
          const runtime = await request("/api/web-agent-runtimes", "POST", {
            sessionId: result.session.id,
            agentId: agent.id,
            role: selection.role,
            modelConfigId: selection.modelConfigId,
          });
          expect(runtime.status).toBe(200);
          const started = await request(
            `/api/web-agent-runtimes/${runtime.body.data.id}/start`,
            "POST",
            {},
          );
          expect(started.status, JSON.stringify(started.body)).toBe(200);
        } else if (selection.mode === "managed_proxy") {
          const route = await request(
            `/api/sessions/${result.session.id}/member-routes/${agent.id}`,
            "PUT",
            {
              accessMode: "managed_proxy",
              binding: selection.binding,
              expectedBindingVersion: 1,
              reason: "Test external Host with native Keeper",
            },
          );
          expect(route.status, JSON.stringify(route.body)).toBe(200);
          expect(
            (
              await request(
                `/api/sessions/${result.session.id}/member-routes/${agent.id}/verify`,
                "POST",
                {
                  expectedBindingVersion:
                    route.body.data.member.route.bindingVersion,
                },
              )
            ).status,
          ).toBe(200);
        }
      }
      return { ...result, members, warnings: [] };
    }
    const result = await request("/api/sessions/setup", "POST", {
      sessionName: name,
      projectPath: project,
      agents,
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    return result.body.data;
  };
  const tool = async (
    sessionId: string,
    agentId: string,
    toolName: string,
    args = {},
  ) =>
    (
      await request("/api/mcp/call", "POST", {
        sessionId,
        agentId,
        toolName,
        arguments: args,
      })
    ).body.data;
  return { root, project, core, base, request, setup, tool };
}

describe("project-bound session setup and isolated knowledge", () => {
  it("lists native CLI sessions only when their saved workspace matches the selected project", async () => {
    const f = await fixture();
    const namespace = join(f.root, "codex-home");
    const sessions = join(namespace, "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, "native-123.jsonl"),
      JSON.stringify({
        type: "session_meta",
        payload: { id: "native-123", cwd: f.project },
      }) + "\n",
    );
    writeFileSync(
      join(sessions, "other-session.jsonl"),
      JSON.stringify({
        type: "session_meta",
        payload: { id: "other-session", cwd: f.root },
      }) + "\n",
    );
    const installation = await f.request("/api/tool-installations", "POST", {
      toolId: "codex",
      displayName: "Test Codex",
      executablePath: process.execPath,
    });
    expect(installation.status).toBe(200);
    const query = new URLSearchParams({
      workspacePath: f.project,
      runtimeNamespace: namespace,
    });
    const result = await f.request(
      `/api/tool-installations/${installation.body.data.installation.id}/native-sessions?${query}`,
    );
    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({
      truncated: false,
      sessions: [{ id: "native-123", workspacePath: f.project }],
    });
  });

  it("lets external Host inspect exact member histories and reply to client input without a self-message loop", async () => {
    const f = await fixture();
    const a = await f.setup("chat-A", [
      waiting("host", "Host"),
      waiting("worker", "Frontend"),
      waiting("knowledge_keeper", "Keeper"),
    ]);
    const b = await f.setup("chat-B", [
      waiting("host", "Host"),
      waiting("worker", "Frontend"),
    ]);
    const worker = a.members.find((m: any) => m.role === "worker");
    const send = async (
      session: any,
      from: string,
      to: string,
      type: string,
      payload: unknown,
      correlationId = "thread-A",
    ) => {
      const result = await f.request("/api/messages/send", "POST", {
        sessionId: session.session.id,
        fromAgentId: from,
        toAgentId: to,
        type,
        payload,
        correlationId,
      });
      expect(result.status).toBe(200);
      return result.body.data;
    };
    await send(a, a.agent.id, worker.id, "task", "EXACT_FRONTEND_TASK");
    await send(a, worker.id, a.agent.id, "result", "EXACT_FRONTEND_RESULT");
    await send(a, worker.id, a.agent.id, "progress", "x".repeat(13000));
    const other = await send(
      b,
      b.agent.id,
      b.members.find((m: any) => m.role === "worker").id,
      "task",
      "PRIVATE_SESSION_B",
    );
    const before = (await f.request(`/api/sessions/${a.session.id}/messages`))
      .body.data.messages;
    const first = await f.tool(a.session.id, a.agent.id, "query_messages", {
      memberName: "Frontend",
      limit: 1,
    });
    expect(first.success).toBe(true);
    expect(first.result.hasMore).toBe(true);
    const next = await f.tool(a.session.id, a.agent.id, "query_messages", {
      memberId: worker.id,
      beforeMessageId: first.result.nextBeforeMessageId,
      limit: 2,
    });
    const all = [...first.result.messages, ...next.result.messages];
    expect(new Set(all.map((m: any) => m.id)).size).toBe(3);
    expect(all.every((m: any) => m.sessionId === a.session.id)).toBe(true);
    expect(
      all.some((m: any) => m.payloadTruncated && m.payload.length === 12000),
    ).toBe(true);
    expect(next.result.hasMore).toBe(false);
    expect(JSON.stringify(all)).toContain("EXACT_FRONTEND_TASK");
    expect(
      (
        await f.tool(a.session.id, a.agent.id, "query_messages", {
          correlationId: "unknown",
        })
      ).result.messages,
    ).toEqual([]);
    for (const args of [
      { memberName: "Front" },
      { memberId: b.agent.id },
      { beforeMessageId: other.id },
      { limit: 51 },
      { limit: 1.5 },
    ]) {
      expect(
        (await f.tool(a.session.id, a.agent.id, "query_messages", args))
          .success,
      ).toBe(false);
    }
    expect(
      (await f.tool(a.session.id, worker.id, "query_messages")).success,
    ).toBe(false);
    expect(
      (await f.request(`/api/sessions/${a.session.id}/messages`)).body.data
        .messages,
    ).toEqual(before);
    const input = await send(
      a,
      a.agent.id,
      a.agent.id,
      "instruction",
      { kind: "web_user_message", content: "Check Frontend progress" },
      "user-thread",
    );
    // Claim only client instructions so worker reports are left untouched.
    const claimed = await f.tool(a.session.id, a.agent.id, "claim_next", {
      types: ["instruction"],
    });
    expect(claimed.result.id).toBe(input.id);
    const done = await f.tool(a.session.id, a.agent.id, "resolve_message", {
      messageId: input.id,
      summary: "FRONTEND_REVIEWED_REPLY",
    });
    expect(done.success, JSON.stringify(done)).toBe(true);
    const messages = (await f.request(`/api/sessions/${a.session.id}/messages`))
      .body.data.messages;
    const reply = messages.find((m: any) => m.payload?.kind === "host_reply");
    expect(reply).toMatchObject({
      fromAgentId: a.agent.id,
      toAgentId: a.agent.id,
      processingStatus: "processed",
      correlationId: "user-thread",
      payload: { content: "FRONTEND_REVIEWED_REPLY", inReplyTo: input.id },
    });
    expect(
      (
        await f.tool(a.session.id, a.agent.id, "claim_next", {
          types: ["instruction"],
        })
      ).result,
    ).toBeNull();
    expect(
      (
        await f.tool(a.session.id, a.agent.id, "resolve_message", {
          messageId: input.id,
          summary: "duplicate",
        })
      ).success,
    ).toBe(false);
    expect(
      (
        await f.request(`/api/sessions/${a.session.id}/messages`)
      ).body.data.messages.filter((m: any) => m.payload?.kind === "host_reply"),
    ).toHaveLength(1);
  });

  it("validates the complete configuration and rolls back partially registered members", async () => {
    const f = await fixture();
    for (const agents of [
      [],
      [waiting("worker", "only-worker")],
      [local("host", "same"), waiting("worker", "same")],
      [waiting("host", "Host")],
      [{ ...waiting("host", "Host"), mode: "cli_await" }],
      [local("host", "Host", { modelConfigId: " " })],
      [{ ...waiting("host", "Host"), mode: "managed_proxy" }],
    ]) {
      expect(
        (
          await f.request("/api/sessions/setup", "POST", {
            sessionName: "invalid",
            projectPath: f.project,
            agents,
          })
        ).status,
      ).toBe(400);
    }
    const bad = await f.request("/api/sessions/setup", "POST", {
      sessionName: "rollback",
      projectPath: f.project,
      agents: [
        local("host", "Host"),
        {
          ...waiting("worker", "Proxy"),
          mode: "managed_proxy",
          binding: {
            installationId: "missing",
            workspacePath: f.project,
            runtimeNamespace: f.root,
            nativeSessionId: "existing",
          },
        },
      ],
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(
      f.core.databaseManager.connection
        .prepare("SELECT COUNT(*) AS n FROM sessions")
        .get()?.n,
    ).toBe(0);
    expect(
      f.core.databaseManager.connection
        .prepare("SELECT COUNT(*) AS n FROM agents")
        .get()?.n,
    ).toBe(0);
    expect(
      (
        await f.request("/api/sessions/setup", "POST", {
          sessionName: "bad-dir",
          projectPath: join(f.project, "source.txt"),
          agents: [local("host", "Host")],
        })
      ).status,
    ).toBe(400);
  });

  it("discovers external Hosts by project without creating or replacing sessions", async () => {
    const f = await fixture();
    const attach = (
      sessionName: string,
      projectPath?: string,
      agentName = "IDE Host",
    ) =>
      f.request("/api/sessions/attach", "POST", {
        sessionName,
        agentName,
        role: "host",
        roleDescription: "Coordinate from an external IDE",
        ...(projectPath ? { projectPath } : {}),
      });
    const a = (await attach("external-A", f.project)).body.data;
    const projectB = join(f.root, "project-b");
    mkdirSync(projectB);
    await attach("external-B", projectB);
    const legacy = (await attach("legacy")).body.data;
    const scan = await f.request("/api/sessions/discover", "POST", {
      projectPath: f.project,
    });
    expect(scan.status).toBe(200);
    expect(scan.body.data.unassignedSessionCount).toBe(1);
    expect(scan.body.data.sessions.map((s: any) => s.id)).toEqual([
      a.session.id,
    ]);
    expect(scan.body.data.sessions[0].host).toMatchObject({
      id: a.agent.id,
      agentName: "IDE Host",
      accessMode: "cli_await",
    });
    expect(
      (await f.request("/api/sessions/discover", "POST", {})).body.data
        .sessions,
    ).toHaveLength(3);
    const alias = join(f.root, "project-alias");
    symlinkSync(
      f.project,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(
      (
        await f.request("/api/sessions/discover", "POST", {
          projectPath: alias,
        })
      ).body.data.sessions.map((s: any) => s.id),
    ).toEqual([a.session.id]);
    if (process.platform === "win32")
      expect(
        (
          await f.request("/api/sessions/discover", "POST", {
            projectPath: f.project.toUpperCase(),
          })
        ).body.data.sessions,
      ).toHaveLength(1);
    expect(
      (
        await f.request("/api/sessions/discover", "POST", {
          projectPath: join(f.root, "missing"),
        })
      ).status,
    ).toBe(400);
    const resumed = await attach("external-A", f.project);
    expect(resumed.body.data.reusedExistingSession).toBe(true);
    expect(resumed.body.data.agent.id).toBe(a.agent.id);
    expect((await attach("external-A", projectB)).status).toBe(400);
    expect((await attach("legacy", f.project, "imposter")).status).toBe(409);
    expect(
      (await f.request(`/api/sessions/${legacy.session.id}`)).body.data
        .projectPath,
    ).toBeNull();
    expect((await attach("legacy", f.project)).body.data.session.id).toBe(
      legacy.session.id,
    );
    expect(
      (
        await f.request("/api/sessions/discover", "POST", {
          projectPath: f.project,
        })
      ).body.data.sessions,
    ).toHaveLength(2);
    expect(
      f.core.databaseManager.connection
        .prepare("SELECT COUNT(*) AS n FROM sessions")
        .get()?.n,
    ).toBe(3);
  });

  it("creates a Host-only session and rejects deleted model selections before persisting state", async () => {
    const f = await fixture();
    const rejected = await f.request("/api/sessions/setup", "POST", {
      sessionName: "deleted-model",
      projectPath: f.project,
      agents: [local("host", "Host", { modelConfigId: "deleted-model" })],
    });
    expect(rejected.status).toBe(400);
    expect((await f.request("/api/sessions")).body.data.sessions).toEqual([]);
    const created = await f.setup("host-only", [local("host", "Host")]);
    expect(created.members).toHaveLength(1);
    expect(created.agent.role).toBe("host");
    expect(
      (await f.request(`/api/knowledge?sessionId=${created.session.id}`)).body
        .data.items,
    ).toEqual([]);
    const scan = (await f.request("/api/sessions/discover", "POST", {})).body
      .data;
    expect(scan.sessions).toHaveLength(1);
    expect(scan.sessions[0].host).toMatchObject({
      id: created.agent.id,
      accessMode: "core_runtime",
    });
  });

  it("keeps registration metadata out of knowledge and sends unreviewed worker facts to the Keeper with the project hierarchy", async () => {
    const f = await fixture();
    const created = await f.setup("knowledge-intent", [
      local("host", "Host"),
      waiting("worker", "Worker"),
      waiting("knowledge_keeper", "Keeper"),
    ]);
    expect(
      (await f.request(`/api/knowledge?sessionId=${created.session.id}`)).body
        .data.items,
    ).toEqual([]);
    const initial = (
      await f.request(`/api/sessions/${created.session.id}/messages`)
    ).body.data.messages.find(
      (m: any) => m.payload?.kind === "knowledge_initial_review.v1",
    );
    expect(initial.payload.content).toContain("L1 may stay empty");
    expect(initial.payload.content).toContain("L2 领域规则");
    expect(initial.payload.content).toContain("L3 字段对齐");
    const worker = created.members.find((m: any) => m.role === "worker");
    await f.request("/api/messages/send", "POST", {
      sessionId: created.session.id,
      fromAgentId: worker.id,
      toAgentId: created.agent.id,
      type: "result",
      payload: "WORKER_CLAIMS_ALL_TESTS_PASS",
    });
    const review = (
      await f.request(`/api/sessions/${created.session.id}/messages`)
    ).body.data.messages.find(
      (m: any) => m.payload?.kind === "knowledge_maintenance_task.v1",
    );
    expect(review.payload.content).toContain(
      "NOT been verified or accepted by the Host",
    );
    expect(review.payload.content).toContain("WORKER_CLAIMS_ALL_TESTS_PASS");
    expect(review.payload.content).toContain("Report no change");
    expect(
      (await f.request(`/api/knowledge?sessionId=${created.session.id}`)).body
        .data.items,
    ).toEqual([]);
  });

  it("creates a CLI Host binding without requiring an existing native session ID", async () => {
    const f = await fixture();
    const namespace = join(f.root, "codex-home");
    mkdirSync(namespace);
    const installation = await f.request("/api/tool-installations", "POST", {
      toolId: "codex",
      displayName: "Codex",
      executablePath: process.execPath,
    });
    const created = await f.request("/api/sessions/setup", "POST", {
      sessionName: "new-cli-host",
      projectPath: f.project,
      agents: [
        {
          role: "host",
          name: "Codex 主控",
          duty: "Coordinate",
          mode: "managed_proxy",
          nativeSessionMode: "create",
          binding: {
            installationId: installation.body.data.installation.id,
            workspacePath: f.project,
            runtimeNamespace: namespace,
          },
        },
      ],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body.data.warnings).toEqual([]);
    const member = created.body.data.members[0];
    const routes = await f.request(
      `/api/sessions/${created.body.data.session.id}/member-routes`,
    );
    expect(
      routes.body.data.members.find((item: any) => item.agent.id === member.id)
        .route,
    ).toMatchObject({
      accessMode: "managed_proxy",
      bindingStatus: "initializing",
    });
  });

  it("creates local Host/Worker/Keeper and external IDE members together, persisting the project", async () => {
    const f = await fixture();
    const created = await f.setup("mixed", [
      local("host", "主控"),
      local("worker", "开发者"),
      local("knowledge_keeper", "知识库维护者"),
      waiting("worker", "IDE 审查"),
    ]);
    expect(created.members).toHaveLength(4);
    expect(created.session.projectPath).toBe(realpathSync(f.project));
    const console = (
      await f.request(`/api/sessions/${created.session.id}/console`)
    ).body.data.console;
    expect(console.session.projectPath).toBe(realpathSync(f.project));
    expect(
      console.members.map((m: any) => [m.agentName, m.route.accessMode]),
    ).toEqual(
      expect.arrayContaining([
        ["主控", "core_runtime"],
        ["开发者", "core_runtime"],
        ["知识库维护者", "core_runtime"],
        ["IDE 审查", "mcp_await"],
      ]),
    );
    const runtimes = (
      await f.request(`/api/web-agent-runtimes?sessionId=${created.session.id}`)
    ).body.data;
    expect(runtimes.map((r: any) => r.role).sort()).toEqual([
      "host",
      "knowledge_keeper",
      "worker",
    ]);
    expect(runtimes.every((r: any) => r.status === "running")).toBe(true);
  });

  it("queues an initial knowledge review when a session has a keeper", async () => {
    const f = await fixture();
    const created = await f.setup("keeper-kickoff", [
      local("host", "Host"),
      waiting("knowledge_keeper", "Keeper"),
    ]);
    const keeper = created.members.find(
      (member: any) => member.role === "knowledge_keeper",
    );
    const messages = (
      await f.request(`/api/sessions/${created.session.id}/messages`)
    ).body.data.messages;
    expect(messages).toContainEqual(
      expect.objectContaining({
        fromAgentId: created.agent.id,
        toAgentId: keeper.id,
        type: "task",
        payload: expect.objectContaining({
          kind: "knowledge_initial_review.v1",
        }),
      }),
    );
  });

  it("isolates API and MCP knowledge, keeps context current and restricts filesystem tools to the project", async () => {
    const f = await fixture();
    const a = await f.setup("A", [
      waiting("host", "Host"),
      waiting("worker", "Worker"),
      waiting("knowledge_keeper", "Keeper"),
    ]);
    const b = await f.setup("B");
    const keeper = a.members.find((m: any) => m.role === "knowledge_keeper");
    const worker = a.members.find((m: any) => m.role === "worker");
    for (const [session, content] of [
      [a, "ONLY_SESSION_A"],
      [b, "ONLY_SESSION_B"],
    ] as const) {
      expect(
        (
          await f.request("/api/knowledge/l1/direction", "PUT", {
            sessionId: session.session.id,
            title: "Direction",
            content,
          })
        ).status,
      ).toBe(200);
    }
    expect(
      (
        await f.tool(a.session.id, worker.id, "knowledge_read", {
          level: "l1",
          slug: "direction",
        })
      ).result.content,
    ).toBe("ONLY_SESSION_A");
    expect(
      (
        await f.tool(b.session.id, b.agent.id, "knowledge_read", {
          level: "l1",
          slug: "direction",
        })
      ).result.content,
    ).toBe("ONLY_SESSION_B");
    expect(
      (
        await f.tool(a.session.id, keeper.id, "knowledge_update", {
          level: "l1",
          slug: "direction",
          title: "Direction",
          content: "LATEST_SESSION_A",
        })
      ).success,
    ).toBe(true);
    expect(
      (await f.request(`/api/knowledge/l1/direction?sessionId=${a.session.id}`))
        .body.data.document.content,
    ).toBe("LATEST_SESSION_A");
    expect(
      (await f.request(`/api/knowledge/l1/direction?sessionId=${b.session.id}`))
        .body.data.document.content,
    ).toBe("ONLY_SESSION_B");
    expect(
      (
        await f.tool(a.session.id, worker.id, "knowledge_update", {
          level: "l1",
          slug: "direction",
          title: "Direction",
          content: "bad",
        })
      ).success,
    ).toBe(false);
    expect(
      (
        await f.tool(b.session.id, keeper.id, "knowledge_read", {
          level: "l1",
          slug: "direction",
        })
      ).success,
    ).toBe(false);
    const file = await f.tool(a.session.id, a.agent.id, "file_read", {
      path: "source.txt",
    });
    expect(file.success, JSON.stringify(file)).toBe(true);
    expect(JSON.stringify(file.result)).toContain("SOURCE_CONTENT_86");
    expect(
      (
        await f.tool(a.session.id, worker.id, "file_write", {
          path: "new/answer.txt",
          content: "42",
        })
      ).success,
    ).toBe(true);
    expect(readFileSync(join(f.project, "new/answer.txt"), "utf8")).toBe("42");
    expect(
      (
        await f.tool(a.session.id, a.agent.id, "file_write", {
          path: "host-write.txt",
          content: "bad",
        })
      ).success,
    ).toBe(false);
    expect(
      (
        await f.tool(a.session.id, worker.id, "file_read", {
          path: "../preferences.json",
        })
      ).success,
    ).toBe(false);
    const outside = join(f.root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "private.txt"), "not-in-project");
    symlinkSync(
      outside,
      join(f.project, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(
      (
        await f.tool(a.session.id, worker.id, "file_read", {
          path: "escape/private.txt",
        })
      ).success,
    ).toBe(false);
  });

  it("runs selected MCP and project tools in a local Host before replying", async () => {
    const f = await fixture();
    const calls: any[] = [];
    const longTool = "inspect__the_selected_project_with_a_very_long_tool_name";
    const http = createHttpServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      res.setHeader("content-type", "application/json");
      if (req.url === "/mcp") {
        if (body.method === "tools/list")
          return void res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                tools: [
                  {
                    name: longTool,
                    description: "Inspect selected project",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
              },
            }),
          );
        calls.push(body);
        return void res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text: "REAL_MCP_RESULT_74" }] },
          }),
        );
      }
      calls.push(body);
      const messages = body.messages as any[];
      const done = messages.some((m) => m.role === "tool");
      const external = body.tools.find((t: any) =>
        t.function.name.startsWith("ext_"),
      );
      const tool_calls = done
        ? undefined
        : [
            {
              id: "external",
              type: "function",
              function: { name: external.function.name, arguments: "{}" },
            },
            {
              id: "source",
              type: "function",
              function: {
                name: "file_read",
                arguments: JSON.stringify({ path: "source.txt" }),
              },
            },
            {
              id: "knowledge",
              type: "function",
              function: {
                name: "knowledge_read",
                arguments: JSON.stringify({ level: "l1", slug: "direction" }),
              },
            },
            {
              id: "history",
              type: "function",
              function: {
                name: "query_messages",
                arguments: JSON.stringify({ memberName: "Reviewer" }),
              },
            },
          ];
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: done ? "NOT_CONFIRMED: PROJECT_AND_MCP_VERIFIED" : "",
                tool_calls,
              },
            },
          ],
        }),
      );
    });
    await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
    cleanup.push(() => new Promise<void>((done) => http.close(() => done())));
    const endpoint = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    const model = (
      await f.request("/api/models", "POST", {
        name: "Fixture",
        provider: "openai",
        modelId: "fixture",
        baseUrl: endpoint,
        apiKey: "test",
      })
    ).body.data;
    const mcp = (
      await f.request("/api/mcp-servers", "POST", {
        name: "Project MCP",
        url: endpoint + "/mcp",
        transport: "sse",
      })
    ).body.data;
    const created = await f.setup("real-tools", [
      local("host", "Host", {
        modelConfigId: model.id,
        externalMcpServerIds: [mcp.id],
      }),
      waiting("worker", "Reviewer"),
    ]);
    const reviewer = created.members.find(
      (member: any) => member.agentName === "Reviewer",
    );
    await f.request("/api/messages/send", "POST", {
      sessionId: created.session.id,
      fromAgentId: reviewer.id,
      toAgentId: created.agent.id,
      type: "progress",
      payload: "REVIEWER_HISTORY_29",
    });
    await f.request("/api/knowledge/l1/direction", "PUT", {
      sessionId: created.session.id,
      title: "Current",
      content: "CURRENT_DECISION_91",
    });
    expect(
      (
        await f.request("/api/messages/send", "POST", {
          sessionId: created.session.id,
          fromAgentId: created.agent.id,
          toAgentId: created.agent.id,
          type: "instruction",
          payload: {
            kind: "web_user_message",
            content: "Inspect the project and current decision.",
          },
        })
      ).status,
    ).toBe(200);
    await until(
      () => f.request(`/api/sessions/${created.session.id}/messages`),
      (r) => JSON.stringify(r.body).includes("PROJECT_AND_MCP_VERIFIED"),
    );
    const modelCalls = calls.filter((c) => c.messages);
    expect(modelCalls).toHaveLength(2);
    expect(JSON.stringify(modelCalls[0])).toContain("PROJECT_ORIENTATION_42");
    expect(JSON.stringify(modelCalls[0])).toContain("CURRENT_DECISION_91");
    expect(
      JSON.stringify(
        modelCalls[1].messages.filter((m: any) => m.role === "tool"),
      ),
    ).toContain("REAL_MCP_RESULT_74");
    expect(
      JSON.stringify(
        modelCalls[1].messages.filter((m: any) => m.role === "tool"),
      ),
    ).toContain("SOURCE_CONTENT_86");
    expect(
      JSON.stringify(
        modelCalls[1].messages.filter((m: any) => m.role === "tool"),
      ),
    ).toContain("REVIEWER_HISTORY_29");
    const alias = externalToolName(mcp.id, longTool);
    expect(alias.length).toBeLessThanOrEqual(64);
    expect(
      calls.some(
        (c) => c.method === "tools/call" && c.params.name === longTool,
      ),
    ).toBe(true);
  }, 30000);

  it("lets a native Keeper update only its own session through a temporary tool bridge", async () => {
    const f = await fixture();
    const namespace = join(f.root, "native");
    mkdirSync(join(namespace, "sessions"), { recursive: true });
    const executable = join(f.root, "native-fixture.cjs");
    writeFileSync(
      join(namespace, "sessions", "keeper-native.jsonl"),
      JSON.stringify({
        type: "session_meta",
        payload: { id: "keeper-native", cwd: f.project },
      }) + "\n",
    );
    writeFileSync(
      executable,
      `
      if(process.argv.includes('--version')){console.log('keeper-fixture-1');process.exit(0)}
      let prompt='';process.stdin.on('data',d=>prompt+=d);process.stdin.on('end',()=>{
        const script=prompt.match(/Script: ([^\\r\\n]+)/)[1];
        const result=require('node:child_process').spawnSync(process.execPath,[script,'knowledge_update',JSON.stringify({level:'l2',slug:'native-keeper',title:'Native facts',content:'NATIVE_KEEPER_WRITTEN'})],{encoding:'utf8'});
        if(result.status!==0){console.error(result.stderr+result.stdout);process.exit(1)}
        console.log(JSON.stringify({type:'thread.started',thread_id:'keeper-native'}));
        console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'NATIVE_KEEPER_DONE'}}));
        console.log(JSON.stringify({type:'turn.completed'}));
      });`,
    );
    const installed = (
      await f.request("/api/tool-installations", "POST", {
        toolId: "codex",
        displayName: "Fixture",
        executablePath: executable,
      })
    ).body.data.installation;
    const created = await f.setup("native-keeper", [
      waiting("host", "Host"),
      {
        ...waiting("knowledge_keeper", "Keeper"),
        mode: "managed_proxy",
        binding: {
          installationId: installed.id,
          workspacePath: f.project,
          runtimeNamespace: namespace,
          nativeSessionId: "keeper-native",
        },
      },
    ]);
    expect(created.warnings).toEqual([]);
    const keeper = created.members.find(
      (m: any) => m.role === "knowledge_keeper",
    );
    const runtime = await f.request("/api/web-agent-runtimes", "POST", {
      sessionId: created.session.id,
      agentId: keeper.id,
      role: "knowledge_keeper",
      modelConfigId: "default-model",
    });
    expect(runtime.status).toBe(400);
    expect(
      (
        await f.request("/api/messages/send", "POST", {
          sessionId: created.session.id,
          fromAgentId: created.agent.id,
          toAgentId: keeper.id,
          type: "task",
          payload: "Maintain knowledge",
        })
      ).status,
    ).toBe(200);
    await until(
      () => f.request(`/api/sessions/${created.session.id}/messages`),
      (r) => JSON.stringify(r.body).includes("NATIVE_KEEPER_DONE"),
    );
    expect(
      (
        await f.request(
          `/api/knowledge/l2/native-keeper?sessionId=${created.session.id}`,
        )
      ).body.data.document.content,
    ).toBe("NATIVE_KEEPER_WRITTEN");
    const reports = (
      await f.request(`/api/sessions/${created.session.id}/messages`)
    ).body.data.messages;
    expect(reports.find((m: any) => m.type === "result").payload.kind).toBe(
      "knowledge_maintenance_report",
    );
    await until(
      async () => readdirSync(join(f.root, "proxy-bridges")),
      (files) => files.length === 0,
    );
    expect(
      f.core.databaseManager.connection
        .prepare(
          "SELECT revoked_at AS revokedAt FROM member_credentials WHERE label LIKE 'proxy-execution:%'",
        )
        .get()?.revokedAt,
    ).toBeTruthy();
  }, 30000);

  it("lets a local Worker change the selected project, report to Host and retain history with fresh knowledge", async () => {
    const f = await fixture();
    const requests: any[] = [];
    const http = createHttpServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      const hasOutput = body.messages.some((m: any) => m.role === "tool");
      const phase = JSON.stringify(body.messages).includes("SECOND_TASK")
        ? "two"
        : "one";
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: hasOutput ? `WORKER_DONE_${phase}` : "",
                ...(hasOutput
                  ? {}
                  : {
                      tool_calls: [
                        {
                          id: "write",
                          type: "function",
                          function: {
                            name: "file_write",
                            arguments: JSON.stringify({
                              path: "worker.txt",
                              content: phase,
                            }),
                          },
                        },
                      ],
                    }),
              },
            },
          ],
        }),
      );
    });
    await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
    cleanup.push(() => new Promise<void>((done) => http.close(() => done())));
    const baseUrl = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    const model = (
      await f.request("/api/models", "POST", {
        name: "Worker fixture",
        provider: "openai",
        modelId: "fixture",
        baseUrl,
        apiKey: "test",
      })
    ).body.data;
    const created = await f.setup("worker-execution", [
      waiting("host", "Host"),
      local("worker", "Worker", { modelConfigId: model.id }),
    ]);
    const worker = created.members.find((m: any) => m.role === "worker");
    for (const task of ["FIRST_TASK", "SECOND_TASK"]) {
      if (task === "SECOND_TASK") {
        await f.request("/api/knowledge/l1/new-rule", "PUT", {
          sessionId: created.session.id,
          title: "New rule",
          content: "KNOWLEDGE_UPDATED_BETWEEN_TASKS",
        });
        expect(
          (
            await f.request(
              `/api/sessions/${created.session.id}/join`,
              "POST",
              {
                agentName: "NEW_IDE_MEMBER",
                displayName: "New IDE",
                role: "worker",
                roleDescription: "Review",
                platform: "generic",
                capabilities: [],
                connectionMode: "skill-bridge",
              },
            )
          ).status,
        ).toBe(200);
      }
      expect(
        (
          await f.request("/api/messages/send", "POST", {
            sessionId: created.session.id,
            fromAgentId: created.agent.id,
            toAgentId: worker.id,
            type: "task",
            payload: task,
          })
        ).status,
      ).toBe(200);
      const expected =
        task === "FIRST_TASK" ? "WORKER_DONE_one" : "WORKER_DONE_two";
      const response = await until(
        () => f.request(`/api/sessions/${created.session.id}/messages`),
        (r) => JSON.stringify(r.body).includes(expected),
      );
      expect(
        response.body.data.messages.find((m: any) => m.payload === expected)
          ?.toAgentId,
      ).toBe(created.agent.id);
    }
    expect(readFileSync(join(f.project, "worker.txt"), "utf8")).toBe("two");
    expect(requests).toHaveLength(4);
    expect(JSON.stringify(requests[2].messages)).toContain("FIRST_TASK");
    expect(JSON.stringify(requests[2].messages)).toContain(
      "KNOWLEDGE_UPDATED_BETWEEN_TASKS",
    );
    expect(JSON.stringify(requests[2].messages)).toContain("NEW_IDE_MEMBER");
    expect(JSON.stringify(requests[0].messages)).toContain(
      "LoopMarshal managed collaboration",
    );
    expect(
      requests[0].tools.some(
        (tool: any) => tool.function.name === "session_context",
      ),
    ).toBe(true);
  }, 30000);
});
